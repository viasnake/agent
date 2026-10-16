import { join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { AgentError, type Run } from "./types.js";
import { Store } from "./storage.js";
import type { Config } from "./config.js";
import { Sandbox } from "./sandbox.js";
import { atomicWrite, canonical, readText, safePath, sha256 } from "./util.js";
import {
  copyWorkspace,
  inventory,
  readSnapshot,
  workspaceDiff,
} from "./workspace.js";

export interface CheckResult {
  id: string;
  passed: boolean;
  detail: string;
}
export class Evaluator {
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly sandbox: Sandbox,
    readonly notify: (
      type: string,
      detail: Record<string, unknown>,
    ) => void = () => {},
  ) {}
  async validate(run: Run, signal: AbortSignal): Promise<CheckResult[]> {
    if (run.access === "read-only") return [];
    const directory = this.store.runDir(run.id),
      work = join(directory, "work");
    const results: CheckResult[] = [];
    const current = await inventory(work, this.config.limits.maxWorkspaceBytes),
      snapshot = await readSnapshot(directory);
    for (const checkId of run.checks) {
      const check = this.config.checks[checkId];
      if (!check)
        throw new AgentError(
          "CHECK_CONFIG",
          `Unknown required check ${checkId}`,
        );
      for (const prefix of check.protectedPaths) {
        const protectedFiles = Object.keys(snapshot.files).filter(
          (path) =>
            path === prefix || path.startsWith(prefix.replace(/\/$/, "") + "/"),
        );
        if (!protectedFiles.length)
          throw new AgentError(
            "CHECK_CONFIG",
            `No baseline files match protected path ${prefix}`,
          );
        for (const path of protectedFiles) {
          if (snapshot.redactedPaths?.includes(path))
            throw new AgentError(
              "IMAGE_REDACTED",
              `Required check input was excluded by image redaction: ${path}`,
            );
          if (
            canonical(snapshot.files[path]) !== canonical(current[path] ?? null)
          )
            throw new AgentError(
              "PROTECTED_CHECK",
              `Required check input was modified: ${path}`,
            );
        }
      }
      const checkDir = await mkdtemp(join(directory, "check-"));
      try {
        await copyWorkspace(
          work,
          checkDir,
          this.config.limits.maxWorkspaceBytes,
        );
        const operation = this.store.prepare(
          run,
          "validation",
          `check:${checkId}`,
          { command: check.command, snapshot: sha256(canonical(current)) },
        );
        this.store.operation(run, operation, "dispatched");
        try {
          this.notify("check_started", {
            runId: run.id,
            generation: run.generation,
            checkId,
            command: check.command,
          });
          const output = await this.sandbox.execute(
            checkDir,
            check.command,
            signal,
          );
          const artifact = await this.store.artifact(
            run,
            `check-${checkId}.json`,
            "check",
            JSON.stringify(output, null, 2),
            { checkId, manifestSha256: sha256(canonical(current)) },
          );
          this.store.operation(run, operation, "completed", artifact.id);
          results.push({
            id: checkId,
            passed: output.code === 0,
            detail: `exit ${output.code}; artifact ${artifact.id}${output.truncated ? "; output truncated" : ""}`,
          });
          this.notify("check_finished", {
            runId: run.id,
            generation: run.generation,
            checkId,
            command: check.command,
            passed: output.code === 0,
          });
        } catch (error) {
          this.store.operation(run, operation, "unknown");
          this.notify("check_finished", {
            runId: run.id,
            generation: run.generation,
            checkId,
            command: check.command,
            unknown: true,
          });
          throw error;
        }
      } finally {
        await rm(checkDir, { recursive: true, force: true });
      }
    }
    const documents = [
      ...new Set(run.tasks.flatMap((t) => t.result?.artifacts ?? [])),
    ];
    if (run.kind !== "coding" && run.kind !== "chat" && !documents.length)
      results.push({
        id: "artifact-exists",
        passed: false,
        detail: "No output document was reported",
      });
    let combined = "";
    const documentArtifacts: Array<{
      id: string;
      sha256: string;
      name: string;
      text: string;
    }> = [];
    for (const path of documents) {
      const content = await readText(
        await safePath(work, path),
        this.config.limits.maxFileBytes,
      );
      if (!content.trim())
        throw new AgentError("ARTIFACT_MISSING", `Empty output ${path}`);
      combined += "\n" + content;
      const artifact = await this.store.artifact(
        run,
        path,
        "document",
        content,
      );
      documentArtifacts.push({
        id: artifact.id,
        sha256: artifact.sha256,
        name: artifact.name,
        text: content,
      });
    }
    for (const text of run.mustKeep)
      results.push({
        id: "preserve-text",
        passed: combined.includes(text),
        detail: combined.includes(text)
          ? "Required text preserved"
          : `Required text is absent: ${text}`,
      });
    if (run.kind === "research") {
      const excluded = new Set(run.contextState?.excludedSourceIds ?? []);
      const excludedHashes = new Set(
        run.contextState?.excludedSourceHashes ?? [],
      );
      const excludedUrls = new Set(run.contextState?.excludedSourceUrls ?? []);
      const sources = this.store
        .artifacts(run.id)
        .filter(
          (a) =>
            a.kind === "source" &&
            !excluded.has(a.id) &&
            !excludedHashes.has(a.sha256) &&
            !excludedHashes.has(String(a.metadata.rawSha256 ?? "")) &&
            !excludedHashes.has(String(a.metadata.selectedSha256 ?? "")) &&
            !excludedUrls.has(String(a.metadata.url ?? "")) &&
            !excludedUrls.has(String(a.metadata.requestedUrl ?? "")),
        );
      const citations = [
        ...combined.matchAll(/\[source:([a-f0-9-]{36}):L(\d+)(?:-L(\d+))?\]/g),
      ];
      results.push({
        id: "research-citations",
        passed: citations.length > 0,
        detail: `${citations.length} source citations`,
      });
      for (const citation of citations) {
        const source = sources.find((s) => s.id === citation[1]);
        if (!source)
          throw new AgentError(
            "INVALID_CITATION",
            `Unknown source ${citation[1]}`,
          );
        const text = (await this.store.content(source)).toString("utf8"),
          lines = text.split("\n").length;
        const first = Number(citation[2]),
          last = Number(citation[3] ?? citation[2]);
        if (first < 1 || last < first || last > lines)
          throw new AgentError(
            "INVALID_CITATION",
            "Citation is outside the stored source",
          );
      }
    }
    if (run.kind === "coding") {
      const delta = await workspaceDiff(
        directory,
        this.config.limits.maxWorkspaceBytes,
      );
      results.push({
        id: "code-diff",
        passed: delta.changes.length > 0,
        detail: `${delta.changes.length} changed files`,
      });
      results.push({
        id: "required-checks",
        passed: run.checks.length > 0,
        detail: `${run.checks.length} required checks`,
      });
      await this.store.artifact(run, "changes.patch", "patch", delta.patch, {
        changes: delta.changes,
      });
    }
    // Shell checks ran on disposable copies; the canonical result must still match.
    if (
      canonical(await inventory(work, this.config.limits.maxWorkspaceBytes)) !==
      canonical(current)
    )
      throw new AgentError(
        "WORKSPACE_CHANGED",
        "Working copy changed during validation",
      );
    const validationArtifact = await this.store.artifact(
      run,
      "validation.json",
      "check",
      JSON.stringify(results, null, 2),
    );
    const excludedSourceIds = new Set(
      run.contextState?.excludedSourceIds ?? [],
    );
    const excludedSourceHashes = new Set(
      run.contextState?.excludedSourceHashes ?? [],
    );
    const excludedSourceUrls = new Set(
      run.contextState?.excludedSourceUrls ?? [],
    );
    const availableSourceIds = this.store
      .artifacts(run.id)
      .filter(
        (artifact) =>
          artifact.kind === "source" &&
          !excludedSourceIds.has(artifact.id) &&
          !excludedSourceHashes.has(artifact.sha256) &&
          !excludedSourceHashes.has(
            String(artifact.metadata.rawSha256 ?? ""),
          ) &&
          !excludedSourceHashes.has(
            String(artifact.metadata.selectedSha256 ?? ""),
          ) &&
          !excludedSourceUrls.has(String(artifact.metadata.url ?? "")) &&
          !excludedSourceUrls.has(String(artifact.metadata.requestedUrl ?? "")),
      )
      .map((artifact) => artifact.id);
    for (const document of documentArtifacts) {
      const citedSourceRanges = [
        ...document.text.matchAll(
          /\[source:([a-f0-9-]{36}):L(\d+)(?:-L(\d+))?\]/g,
        ),
      ].map((match) => ({
        sourceId: match[1],
        startLine: Number(match[2]),
        endLine: Number(match[3] ?? match[2]),
      }));
      const unavailableCitedSourceIds = [
        ...new Set(
          citedSourceRanges
            .map((range) => range.sourceId)
            .filter(
              (sourceId): sourceId is string =>
                typeof sourceId === "string" &&
                !availableSourceIds.includes(sourceId),
            ),
        ),
      ].sort();
      await this.store.artifact(
        run,
        `provenance/${document.id}.json`,
        "report",
        JSON.stringify({
          version: 1,
          type: "provenance",
          documentId: document.id,
          artifactId: document.id,
          artifactSha256: document.sha256,
          producingRunId: run.id,
          parentRunId: run.parentRunId,
          availableInputSourceIds: availableSourceIds,
          citedSourceRanges,
          unavailableCitedSourceIds,
          validationArtifactId: validationArtifact.id,
          semanticCorrectness: "not-established",
        }),
        {
          type: "provenance",
          documentId: document.id,
          documentSha256: document.sha256,
          validationArtifactId: validationArtifact.id,
        },
      );
    }
    if (results.every((r) => r.passed)) {
      await atomicWrite(
        join(directory, "validated-manifest.json"),
        canonical(current),
      );
      await this.store.artifact(
        run,
        "validated-manifest.json",
        "report",
        canonical(current),
      );
    }
    return results;
  }
  async verifyPublished(run: Run): Promise<void> {
    if (run.access === "read-only") return;
    for (const artifact of this.store.artifacts(run.id))
      await this.store.content(artifact);
    const directory = this.store.runDir(run.id),
      approved = await readFile(
        join(directory, "validated-manifest.json"),
        "utf8",
      );
    const current = canonical(
      await inventory(
        join(directory, "work"),
        this.config.limits.maxWorkspaceBytes,
      ),
    );
    if (approved !== current)
      throw new AgentError(
        "ARTIFACT_CHANGED",
        "Validated working copy was modified",
      );
  }
}
