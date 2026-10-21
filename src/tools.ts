import { lstat, readFile, rm, mkdtemp, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { configHash, type Config } from "./config.js";
import { Store } from "./storage.js";
import { Sandbox } from "./sandbox.js";
import {
  atomicWrite,
  canonical,
  errorMessage,
  readText,
  readBoundedFile,
  safePath,
  sha256,
} from "./util.js";
import {
  copyWorkspace,
  inventory,
  readSnapshot,
  secretPath,
} from "./workspace.js";
import { assertDisclosure } from "./policy.js";
import {
  fetchPublic,
  type PublicFetchDependencies,
  type PublicFetchResult,
} from "./network.js";
import { normalizeConversationContext, readContextArchive } from "./context.js";
import { decodeResponse } from "./research.js";
import {
  authorizedSources,
  authorizedTaskReportIds,
  isStructuredCollaboration,
  requireAuthorizedSource,
} from "./collaboration.js";
import { taskReportInstruction } from "./collaboration-prompts.js";
import { codeInfoSchema, inspectCode } from "./code-info.js";
import {
  canUseProfiles,
  developmentDirectory,
  measureDevelopmentDirectory,
} from "./development-runtime.js";
import { reviewWriting, writingOptionsSchema } from "./writing-quality.js";
import { AgentError, type Run, type Task, type ToolSpec } from "./types.js";
import { id } from "./util.js";
import {
  assertContextReady,
  inspectCompletedRead,
  recordContextIssue,
} from "./context-review.js";

const pathSchema = z.string().min(1).max(1000);
export class TaskTools {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly run: Run,
    readonly task: Task,
    readonly root: string,
    readonly sandbox: Sandbox,
    readonly publicFetcher: (
      url: URL,
      signal: AbortSignal,
      allowedHosts: string[],
      maxBytes?: number,
      dependencies?: PublicFetchDependencies,
    ) => Promise<PublicFetchResult> = fetchPublic,
  ) {}
  async close(): Promise<void> {
    await this.queue;
  }
  wrap<S extends z.ZodObject>(
    name: string,
    description: string,
    schema: S,
    execute: (args: z.output<S>, signal: AbortSignal) => Promise<string>,
    beforeDispatch?: (
      args: z.output<S>,
      signal: AbortSignal,
      operationId: string,
    ) => Promise<void>,
  ): ToolSpec {
    return {
      name,
      description,
      parameters: z.toJSONSchema(schema),
      execute: (args, signal) => {
        const action = this.queue.then(async () => {
          signal.throwIfAborted();
          this.store.assertLease(this.run.id, this.run.generation);
          assertContextReady(this.run);
          const parsed = schema.safeParse(args);
          if (!parsed.success)
            throw new AgentError(
              "TOOL_ARGUMENTS",
              parsed.error.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; "),
            );
          const data = structuredClone(parsed.data);
          const operation = this.store.prepare(
            this.run,
            this.task.id,
            name,
            data,
          );
          let dispatched = false,
            completedResult: string | undefined,
            shouldObserve = false;
          try {
            assertContextReady(this.run);
            signal.throwIfAborted();
            this.store.assertLease(this.run.id, this.run.generation);
            if (this.store.cancelRequested(this.run.id))
              throw new AgentError(
                "CANCELLED",
                "Cancellation requested before dispatch",
              );
            assertContextReady(this.run);
            if (beforeDispatch) await beforeDispatch(data, signal, operation);
            this.store.operation(this.run, operation, "dispatched");
            dispatched = true;
            const result = await execute(data, signal);
            signal.throwIfAborted();
            const log = await this.store.artifact(
              this.run,
              `tool-${operation}.txt`,
              "report",
              result,
              { taskId: this.task.id, tool: name, operationId: operation },
            );
            this.store.operation(this.run, operation, "completed", log.id);
            completedResult = result;
            shouldObserve = true;
          } catch (error) {
            // A cancelled external call or killed shell may have completed its side effect.
            const rejected =
              error instanceof AgentError &&
              [
                "TOOL_ARGUMENTS",
                "MCP_CHANGED",
                "MCP_DESTINATION",
                "MCP_AUTH",
                "DISCLOSURE_DENIED",
                "SANDBOX",
              ].includes(error.code);
            const uncertain =
              dispatched &&
              !rejected &&
              (signal.aborted ||
                name === "shell" ||
                name === "run_profile" ||
                name.startsWith("mcp_"));
            this.store.operation(
              this.run,
              operation,
              dispatched && uncertain ? "unknown" : "failed",
              errorMessage(error),
            );
            throw error;
          }
          if (shouldObserve) {
            inspectCompletedRead(this.store, this.run, this.task);
          }
          return completedResult!;
        });
        this.queue = action.catch(() => {});
        return action;
      },
    };
  }
  private async file(path: string, write = false): Promise<string> {
    const root = await realpath(this.root),
      projectedTarget = await safePath(root, path, true),
      normalized = relative(root, projectedTarget).split(sep).join("/"),
      snapshot = await readSnapshot(this.store.runDir(this.run.id));
    if (snapshot.redactedPaths?.includes(normalized))
      throw new AgentError(
        "IMAGE_REDACTED",
        "This path is excluded from the private working copy after image redaction",
      );
    if (secretPath(normalized))
      throw new AgentError(
        "PATH_DENIED",
        "Credential, runtime, and control directories are excluded",
      );
    const target = await safePath(this.root, path, write);
    if (write) {
      if (
        this.run.access === "read-only" ||
        !this.task.write ||
        this.task.role === "reviewer"
      )
        throw new AgentError(
          "WRITE_DENIED",
          "This task has no writer permission",
        );
      for (const checkId of this.run.checks)
        for (const protectedPath of this.config.checks[checkId]!.protectedPaths)
          if (
            normalized === protectedPath ||
            normalized.startsWith(protectedPath.replace(/\/$/, "") + "/")
          )
            throw new AgentError(
              "PROTECTED_CHECK",
              `Cannot modify required check input: ${path}`,
            );
    }
    return target;
  }
  private async executeShell(
    command: string,
    signal: AbortSignal,
    prepareRuntime = false,
  ) {
    const usesRuntime =
      Object.keys(this.config.execution.profiles ?? {}).length > 0 &&
      canUseProfiles(this.run, this.task);
    if (usesRuntime && configHash(this.config) !== this.run.configHash)
      throw new AgentError(
        "PROFILE_CONFIG",
        "Execution settings changed; create a new run with the reviewed configuration",
      );
    const runtime = usesRuntime
      ? {
          path: await developmentDirectory(
            this.store.runDir(this.run.id),
            this.run,
            this.task,
          ),
          readOnly: !prepareRuntime,
        }
      : undefined;
    if (runtime)
      await measureDevelopmentDirectory(
        runtime.path,
        this.config.limits.maxWorkspaceBytes,
      );
    let scratch: string | undefined;
    try {
      if (this.task.role === "reviewer") {
        scratch = await mkdtemp(
          join(this.store.runDir(this.run.id), "review-check-"),
        );
        await copyWorkspace(
          this.root,
          scratch,
          this.config.limits.maxWorkspaceBytes,
        );
      }
      signal.throwIfAborted();
      this.store.assertLease(this.run.id, this.run.generation);
      if (this.store.cancelRequested(this.run.id))
        throw new AgentError(
          "CANCELLED",
          "Cancellation requested before shell execution",
        );
      const result = await this.sandbox.execute(
        scratch ?? this.root,
        command,
        signal,
        scratch ? false : !this.task.write,
        runtime,
      );
      return {
        ...result,
        ...(runtime
          ? {
              runtime: {
                path: "/runtime",
                scope: "task-local",
                readOnly: runtime.readOnly,
                ...(await measureDevelopmentDirectory(
                  runtime.path,
                  this.config.limits.maxWorkspaceBytes,
                )),
              },
            }
          : {}),
      };
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }
  all(): ToolSpec[] {
    const tools: ToolSpec[] = [
      this.wrap(
        "read_source",
        "Read a bounded range from an attached or previously retrieved source by its stable source ID.",
        z.strictObject({
          id: z.string(),
          startLine: z.number().int().positive().default(1),
          lines: z.number().int().min(1).max(500).default(200),
        }),
        async (args) => {
          const source = requireAuthorizedSource(
            this.store,
            this.run,
            this.task,
            args.id,
          );
          const text = (await this.store.content(source))
            .toString("utf8")
            .split("\n");
          return JSON.stringify({
            id: source.id,
            name: source.name,
            totalLines: text.length,
            text: text
              .slice(args.startLine - 1, args.startLine - 1 + args.lines)
              .map((line, i) => `${i + args.startLine}: ${line}`)
              .join("\n"),
          });
        },
      ),
      this.wrap(
        "list_files",
        "List relative file paths and byte sizes in the working copy. Paths outside the copy are inaccessible.",
        z.strictObject({ prefix: z.string().max(500).default("") }),
        async (args) => {
          const files = await inventory(
            this.root,
            this.config.limits.maxWorkspaceBytes,
          );
          const matches = Object.entries(files).filter(([path]) =>
            path.startsWith(args.prefix),
          );
          return JSON.stringify({
            files: matches
              .slice(0, 1000)
              .map(([path, entry]) => ({ path, bytes: entry.bytes })),
            more: matches.length > 1000,
          });
        },
      ),
      this.wrap(
        "read_file",
        "Read UTF-8 text with line numbers and SHA-256. Read a bounded range; use the hash when replacing the file.",
        z.strictObject({
          path: pathSchema,
          startLine: z.number().int().positive().default(1),
          lines: z.number().int().min(1).max(500).default(200),
        }),
        async (args) => {
          const content = await readText(
            await this.file(args.path),
            this.config.limits.maxFileBytes,
          );
          const lines = content.split("\n"),
            start = args.startLine,
            count = args.lines;
          return JSON.stringify({
            sha256: sha256(content),
            totalLines: lines.length,
            text: lines
              .slice(start - 1, start - 1 + count)
              .map((line, i) => `${i + start}: ${line}`)
              .join("\n"),
          });
        },
      ),
      this.wrap(
        "search_files",
        "Find literal text in UTF-8 files; no regular expressions or shell execution.",
        z.strictObject({
          text: z.string().min(1).max(500),
          prefix: z.string().default(""),
        }),
        async (args) => {
          const files = await inventory(
              this.root,
              this.config.limits.maxWorkspaceBytes,
            ),
            matches: Array<{ path: string; line: number; text: string }> = [];
          for (const [path, entry] of Object.entries(files)) {
            if (
              !path.startsWith(args.prefix) ||
              entry.bytes > this.config.limits.maxFileBytes
            )
              continue;
            const data = await readFile(await this.file(path));
            if (data.includes(0)) continue;
            for (const [i, line] of data.toString("utf8").split("\n").entries())
              if (line.includes(args.text)) {
                matches.push({ path, line: i + 1, text: line.slice(0, 1000) });
                if (matches.length >= 100)
                  return JSON.stringify({ matches, more: true });
              }
          }
          return JSON.stringify({ matches, more: false });
        },
      ),
      this.wrap(
        "code_info",
        "Read TypeScript/JavaScript definitions, references or diagnostics from captured source. Positions are 1-based UTF-16 columns. Uses bounded fixed compiler settings, NOT project tsconfig, dependencies, plugins or a build check. No scripts run. Read limitations and truncation in the result; never treat empty diagnostics as a passing project check.",
        codeInfoSchema,
        async (args, signal) =>
          JSON.stringify(
            await inspectCode(
              this.root,
              args,
              this.config.limits.maxWorkspaceBytes,
              async (path) =>
                readBoundedFile(
                  await this.file(path),
                  Math.min(this.config.limits.maxFileBytes, 512_000),
                ),
              signal,
            ),
          ),
      ),
    ];
    if (this.task.role !== "lead")
      tools.push(
        this.wrap(
          "report_context_issue",
          "Report a missing condition, contradiction, or repeated exploration with literal untrusted evidence. This pauses the run for explicit human review.",
          z.strictObject({
            kind: z.enum([
              "missing_condition",
              "contradiction",
              "repeated_exploration",
            ]),
            detail: z.string().min(1).max(4000),
            evidence: z.string().min(1).max(2000),
            sourceIds: z.array(z.string()).max(8).default([]),
            archiveIds: z.array(z.string()).max(8).default([]),
            operationIds: z.array(z.string()).max(8).default([]),
          }),
          async (args) =>
            JSON.stringify({
              status: "needs_user_review",
              issueId: recordContextIssue(
                this.store,
                this.run,
                this.task,
                args,
                "model",
              ).id,
            }),
        ),
      );
    if (this.task.write && this.task.role !== "reviewer")
      tools.push(
        this.wrap(
          "write_file",
          "Create or replace a UTF-8 file in the working copy. Existing files require the exact SHA-256 from read_file; use null to create a new file.",
          z.strictObject({
            path: pathSchema,
            content: z.string(),
            expectedSha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
          }),
          async (args) => {
            const path = await this.file(args.path, true),
              content = args.content;
            if (Buffer.byteLength(content) > this.config.limits.maxFileBytes)
              throw new AgentError("FILE_SIZE", "File exceeds its byte limit");
            const current = await readFile(path).catch((error) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return null;
              throw error;
            });
            if ((current ? sha256(current) : null) !== args.expectedSha256)
              throw new AgentError(
                "FILE_CONFLICT",
                "File changed or expectedSha256 does not match",
              );
            const mode = current ? (await lstat(path)).mode & 0o777 : 0o644;
            await atomicWrite(path, content, mode);
            return JSON.stringify({ path: args.path, sha256: sha256(content) });
          },
        ),
        this.wrap(
          "edit_file",
          "Replace one exact, unique occurrence of text in a UTF-8 file.",
          z.strictObject({
            path: pathSchema,
            oldText: z.string().min(1),
            newText: z.string(),
          }),
          async (args) => {
            const path = await this.file(args.path, true),
              content = await readText(path, this.config.limits.maxFileBytes),
              old = args.oldText;
            if (
              !content.includes(old) ||
              content.indexOf(old) !== content.lastIndexOf(old)
            )
              throw new AgentError(
                "EDIT_MATCH",
                "oldText must match exactly once",
              );
            const next = content.replace(old, () => args.newText);
            if (Buffer.byteLength(next) > this.config.limits.maxFileBytes)
              throw new AgentError("FILE_SIZE", "File exceeds its byte limit");
            await atomicWrite(path, next, (await lstat(path)).mode & 0o777);
            return JSON.stringify({ path: args.path, sha256: sha256(next) });
          },
        ),
        this.wrap(
          "delete_file",
          "Remove a regular file from the working copy after verifying its hash.",
          z.strictObject({
            path: pathSchema,
            expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
          }),
          async (args) => {
            const path = await this.file(args.path, true);
            if (sha256(await readFile(path)) !== args.expectedSha256)
              throw new AgentError("FILE_CONFLICT", "File hash does not match");
            await rm(path);
            return "File removed from working copy";
          },
        ),
      );
    if (this.config.execution.backend !== "disabled")
      tools.push(
        this.wrap(
          "shell",
          "Run a shell command in a network-isolated Linux sandbox. No host home, original Git directory, credentials, or host environment is available. Reviewers receive a disposable writable copy; lead access is read-only.",
          z.strictObject({ command: z.string().min(1).max(8000) }),
          async (args, signal) =>
            JSON.stringify(await this.executeShell(args.command, signal)),
        ),
      );
    const profiles = structuredClone(this.config.execution.profiles ?? {});
    if (
      this.config.execution.backend !== "disabled" &&
      Object.keys(profiles).length &&
      canUseProfiles(this.run, this.task)
    )
      tools.push(
        this.wrap(
          "run_profile",
          "Run a configured dependency/build command offline in the sandbox. Only this tool writes task-local /runtime, which shell mounts read-only. Profiles: " +
            Object.entries(profiles)
              .map(([name, profile]) => `${name}: ${profile.description}`)
              .join("; "),
          z.strictObject({ profile: z.enum(Object.keys(profiles)) }),
          async (args, signal) =>
            JSON.stringify({
              profile: args.profile,
              commandSha256: sha256(profiles[args.profile]!.command),
              ...(await this.executeShell(
                profiles[args.profile]!.command,
                signal,
                true,
              )),
            }),
          async () => {
            if (
              !canUseProfiles(this.run, this.task) ||
              configHash(this.config) !== this.run.configHash
            )
              throw new AgentError(
                "PROFILE_CONFIG",
                "Profile authorization or configuration changed",
              );
          },
        ),
      );
    if (
      this.run.kind === "research" &&
      this.config.web.allowedHosts.length &&
      !this.run.localOnly &&
      this.run.dataClass !== "restricted"
    )
      tools.push(
        this.wrap(
          "fetch_source",
          "Fetch an allowed public HTTPS text source and preserve its body, URL, retrieval time and hash. Cite the returned source ID and line numbers.",
          z.strictObject({ url: z.url() }),
          async (args, signal) => {
            assertDisclosure(
              this.run,
              { local: false, allowedData: this.config.web.allowedData },
              "web fetch",
            );
            if (
              this.task.delegatedBy &&
              (this.task.assignment?.sourceIds.length ?? 0) >= 50
            )
              throw new AgentError(
                "SOURCE_LIMIT",
                "A delegated task cannot be assigned more than 50 sources",
              );
            const requested = new URL(args.url);
            if (
              (this.run.contextState?.excludedSourceUrls ?? []).includes(
                requested.href,
              )
            )
              throw new AgentError(
                "SOURCE_EXCLUDED",
                "This URL belongs to an excluded source family",
              );
            const excludedIds = new Set(
              this.run.contextState?.excludedSourceIds ?? [],
            );
            const excludedHashes = new Set(
              this.run.contextState?.excludedSourceHashes ?? [],
            );
            const excludedUrls = new Set(
              this.run.contextState?.excludedSourceUrls ?? [],
            );
            if (
              this.store
                .artifacts(this.run.id)
                .some(
                  (artifact) =>
                    artifact.kind === "source" &&
                    (artifact.metadata.url === requested.href ||
                      artifact.metadata.requestedUrl === requested.href) &&
                    (excludedIds.has(artifact.id) ||
                      excludedHashes.has(artifact.sha256) ||
                      excludedHashes.has(
                        String(artifact.metadata.rawSha256 ?? ""),
                      ) ||
                      excludedHashes.has(
                        String(artifact.metadata.selectedSha256 ?? ""),
                      )),
                )
            )
              throw new AgentError(
                "SOURCE_EXCLUDED",
                "This URL belongs to an excluded source family",
              );
            const result = await this.publicFetcher(
              new URL(args.url),
              AbortSignal.any([signal, AbortSignal.timeout(30000)]),
              this.config.web.allowedHosts,
              this.config.limits.maxFileBytes,
              { excludedUrls: [...excludedUrls] },
            );
            if (
              excludedUrls.has(result.url) ||
              excludedUrls.has(requested.href)
            )
              throw new AgentError(
                "SOURCE_EXCLUDED",
                "This URL belongs to an excluded source family",
              );
            const rawSha256 = sha256(result.body);
            const extracted = decodeResponse(
              result,
              this.config.limits.maxInputBytes,
            );
            const selectedSha256 = sha256(extracted.text);
            if (
              excludedHashes.has(rawSha256) ||
              excludedHashes.has(selectedSha256)
            )
              throw new AgentError(
                "SOURCE_EXCLUDED",
                "Downloaded bytes match an excluded source family",
              );
            const raw = await this.store.artifact(
              this.run,
              `source-raw/${rawSha256}`,
              "source-raw",
              result.body,
              {
                url: result.url,
                requestedUrl: requested.href,
                rawSha256,
                retrievedAt: result.retrievedAt,
                contentType: result.contentType,
                mediaType: result.mediaType,
                lastModified: result.lastModified,
                private: true,
              },
            );
            const source = await this.store.artifact(
              this.run,
              result.url,
              "source",
              extracted.text,
              {
                url: result.url,
                requestedUrl: requested.href,
                retrievedAt: result.retrievedAt,
                contentType: result.contentType,
                mediaType: result.mediaType,
                charset: result.charset,
                rawArtifactId: raw.id,
                rawSha256,
                selectedSha256,
                extraction: extracted.metadata,
              },
            );
            if (this.task.delegatedBy && this.task.assignment) {
              this.task.assignment = {
                ...this.task.assignment,
                sourceIds: [
                  ...new Set([...this.task.assignment.sourceIds, source.id]),
                ],
              };
              this.store.save(this.run, "delegated_source_added", {
                taskId: this.task.id,
                sourceId: source.id,
              });
            }
            const numbered = extracted.text
              .split("\n")
              .map((line, i) => `${i + 1}: ${line}`)
              .join("\n");
            return JSON.stringify({
              sourceId: source.id,
              sha256: source.sha256,
              url: result.url,
              text: numbered,
            });
          },
        ),
      );
    if (
      this.run.kind === "research" &&
      !this.run.localOnly &&
      this.run.dataClass !== "restricted"
    )
      tools.push(
        this.wrap(
          "search_web",
          "Search an explicitly configured public endpoint for discovery only; snippets are not factual evidence.",
          z.strictObject({
            query: z.string().min(1).max(2000),
            limit: z.number().int().min(1).max(20).default(10),
          }),
          async (args, signal) => {
            assertDisclosure(
              this.run,
              { local: false, allowedData: this.config.web.allowedData },
              "web search",
            );
            const configured = this.config.web.search;
            if (!configured)
              throw new AgentError(
                "SEARCH_UNAVAILABLE",
                "No approved web.search endpoint is configured",
              );
            const url = new URL(configured.endpoint);
            url.searchParams.set(configured.queryParam, args.query);
            const excludedUrls = new Set(
              this.run.contextState?.excludedSourceUrls ?? [],
            );
            if (excludedUrls.has(url.href))
              throw new AgentError(
                "SOURCE_EXCLUDED",
                "This URL belongs to an excluded source family",
              );
            const result = await this.publicFetcher(
              url,
              AbortSignal.any([signal, AbortSignal.timeout(30000)]),
              this.config.web.allowedHosts,
              this.config.limits.maxFileBytes,
              {
                excludedUrls: [...excludedUrls],
              },
            );
            if (excludedUrls.has(result.url) || excludedUrls.has(url.href))
              throw new AgentError(
                "SOURCE_EXCLUDED",
                "This URL belongs to an excluded source family",
              );
            const decoded = decodeResponse(
              result,
              Math.min(this.config.limits.maxInputBytes, 200_000),
            );
            const discoveries = parseDiscoveries(
              decoded.text,
              result,
              args.limit,
              this.config.web.allowedHosts,
            );
            const report = {
              query: args.query,
              searchUrl: url.href,
              url: result.url,
              retrievedAt: result.retrievedAt,
              responseSha256: sha256(result.body),
              discoveryOnly: true,
              results: discoveries,
              responseTruncated: decoded.metadata.truncated === true,
              resultLimit: args.limit,
            };
            await this.store.artifact(
              this.run,
              `research/search-${id()}.json`,
              "report",
              JSON.stringify(report, null, 2),
              { type: "web-search", discoveryOnly: true },
            );
            return JSON.stringify(report);
          },
        ),
      );
    if (
      (this.run.kind === "research" ||
        this.run.contextState?.researchCheckpoint) &&
      (!isStructuredCollaboration(this.run, this.task) ||
        (this.task.resultFormat === "structured" &&
          this.task.purpose === "synthesis"))
    )
      tools.push(
        this.wrap(
          "read_research_checkpoint",
          "Read the current host-retained research checkpoint.",
          z.strictObject({}),
          async () =>
            JSON.stringify(this.run.contextState?.researchCheckpoint ?? null),
        ),
      );
    if (
      this.run.kind === "research" &&
      !isStructuredCollaboration(this.run, this.task)
    ) {
      tools.push(
        this.wrap(
          "research_checkpoint",
          "Save a bounded, source-linked research checkpoint without changing user policy or pins.",
          checkpointSchema,
          async (args) => {
            const checkpoint = {
              ...args,
              author: "model" as const,
              trusted: false as const,
              updatedAt: Date.now(),
            };
            const serialized = canonical(checkpoint);
            if (Buffer.byteLength(serialized) > 32_000)
              throw new AgentError(
                "CHECKPOINT_SIZE",
                "Research checkpoint exceeds the combined 32000-byte limit",
              );
            const available = new Set(
              authorizedSources(this.store, this.run, this.task).map(
                (artifact) => artifact.id,
              ),
            );
            for (const sourceId of checkpoint.decisions.flatMap(
              (decision) => decision.sourceIds,
            ))
              if (!available.has(sourceId))
                throw new AgentError(
                  "SOURCE",
                  `Checkpoint source is not authorized: ${sourceId}`,
                );
            const context = normalizeConversationContext(this.run.contextState);
            context.researchCheckpoint = {
              ...checkpoint,
              unavailableSourceIds:
                context.researchCheckpoint?.unavailableSourceIds,
            };
            this.run.contextState = context;
            this.store.save(this.run, "research_checkpoint", {
              sourceIds: checkpoint.decisions.flatMap(
                (decision) => decision.sourceIds,
              ),
            });
            await this.store.artifact(
              this.run,
              `research/checkpoint-${id()}.json`,
              "report",
              serialized,
              { type: "research-checkpoint", author: "model", trusted: false },
            );
            return serialized;
          },
        ),
      );
    }
    if (this.run.kind === "writing" || this.run.kind === "research")
      tools.push(
        this.wrap(
          "check_writing",
          "Run bounded literal and style heuristics against a protected candidate and an authorized stored source.",
          writingOptionsSchema.extend({
            path: pathSchema,
            sourceId: z.string(),
          }),
          async (args) => {
            const source = requireAuthorizedSource(
              this.store,
              this.run,
              this.task,
              args.sourceId,
            );
            const sourceText = (await this.store.content(source)).toString(
              "utf8",
            );
            if (
              Buffer.byteLength(sourceText) > 1_000_000 ||
              sourceText.split("\n").length > 10_000
            )
              throw new AgentError(
                "WRITING_SIZE",
                "Select a smaller stored source before running the writing check",
              );
            const candidate = await this.file(args.path);
            const candidateText = await readText(
              candidate,
              this.config.limits.maxFileBytes,
            );
            const mustKeep = [
              ...new Set([...(this.run.mustKeep ?? []), ...args.mustKeep]),
            ];
            const review = reviewWriting(sourceText, candidateText, {
              style: args.style,
              mustKeep,
              terminology: args.terminology,
            });
            const report = {
              sourceId: source.id,
              selectedTextSha256: sha256(sourceText),
              candidatePath: args.path,
              review: {
                ...review,
                findings: review.findings.map((finding) => ({
                  ...finding,
                  location:
                    finding.location.document === "source"
                      ? {
                          ...finding.location,
                          sourceId: source.id,
                          selectedTextSha256: sha256(sourceText),
                        }
                      : finding.location.document === "candidate"
                        ? {
                            ...finding.location,
                            candidatePath: args.path,
                            candidateSha256: sha256(candidateText),
                          }
                        : {
                            ...finding.location,
                            requirementIndex: finding.location.line - 1,
                          },
                })),
              },
              heuristicOnly: true,
            };
            await this.store.artifact(
              this.run,
              `writing/check-${id()}.json`,
              "report",
              JSON.stringify(report, null, 2),
              { type: "writing-check", sourceId: source.id },
            );
            return JSON.stringify(report);
          },
        ),
      );
    if (isStructuredCollaboration(this.run, this.task))
      tools.push(
        this.wrap(
          "read_task_report",
          taskReportInstruction,
          z.strictObject({
            reportId: z.string().uuid(),
            start: z.number().int().min(0).default(0),
            bytes: z.number().int().min(1).max(32_000).default(12_000),
          }),
          async (args) => {
            const allowed = authorizedTaskReportIds(this.run, this.task);
            if (!allowed.has(args.reportId))
              throw new AgentError("REPORT", "Task report is not authorized");
            const report = this.store
              .artifacts(this.run.id)
              .find(
                (artifact) =>
                  artifact.id === args.reportId &&
                  artifact.kind === "report" &&
                  artifact.metadata.type === "task-attempt",
              );
            const owner = this.run.tasks.find(
              (candidate) =>
                candidate.id === report?.metadata.taskId &&
                candidate.attemptReportIds?.includes(args.reportId),
            );
            if (
              !report ||
              !owner ||
              !Number.isSafeInteger(report.metadata.attempt) ||
              Number(report.metadata.attempt) < 1 ||
              Number(report.metadata.attempt) > owner.attempts
            )
              throw new AgentError("REPORT", "Task report is unavailable");
            const content = await this.store.content(report),
              parsed = JSON.parse(content.toString("utf8")) as {
                taskId?: unknown;
                attempt?: unknown;
              },
              end = Math.min(content.length, args.start + args.bytes);
            if (
              parsed.taskId !== report.metadata.taskId ||
              parsed.attempt !== report.metadata.attempt ||
              args.start > content.length
            )
              throw new AgentError("REPORT", "Task report range is invalid");
            return content.subarray(args.start, end).toString("utf8");
          },
        ),
      );
    if (
      isStructuredCollaboration(this.run, this.task) ||
      !!(
        this.run.compactions?.length ||
        this.run.contextState?.compactions?.length
      )
    )
      tools.push(
        this.wrap(
          "read_context",
          "Retrieve a bounded excerpt from an archived context belonging to this conversation.",
          z.strictObject({
            archiveId: z.string().regex(/^[a-f0-9]{64}$/),
            start: z.number().int().min(0).default(0),
            bytes: z.number().int().min(1).max(32000).default(12000),
          }),
          async (args) => {
            if (
              isStructuredCollaboration(this.run, this.task) &&
              !(this.task.contextArchiveIds ?? []).includes(args.archiveId)
            )
              throw new AgentError(
                "CONTEXT_ARCHIVE",
                "This task cannot read another task's context archive",
              );
            if (this.run.contextState?.excludedSourceIds?.length)
              throw new AgentError(
                "SOURCE_EXCLUDED",
                "Context archives are unavailable after source exclusion",
              );
            const text = await readContextArchive(
              this.store.paths,
              this.run,
              args.archiveId,
              args.bytes,
              args.start,
            );
            return text;
          },
        ),
      );
    if (this.task.delegatedBy || this.task.purpose === "synthesis")
      return tools.filter((tool) =>
        [
          "read_file",
          "list_files",
          "search_files",
          "code_info",
          "read_source",
          "read_context",
          "read_task_report",
          "report_context_issue",
          ...(this.task.purpose === "synthesis" &&
          this.run.contextState?.researchCheckpoint
            ? ["read_research_checkpoint"]
            : []),
          ...(this.run.kind === "research" && this.task.purpose !== "synthesis"
            ? ["fetch_source", "search_web"]
            : []),
          ...(this.run.kind === "writing" || this.run.kind === "research"
            ? ["check_writing"]
            : []),
        ].includes(tool.name),
      );
    if (this.run.access === "read-only")
      return tools.filter((tool) =>
        [
          "read_file",
          "read_source",
          "list_files",
          "search_files",
          "code_info",
          "read_context",
          ...(this.run.kind === "research"
            ? [
                "fetch_source",
                "search_web",
                ...(!isStructuredCollaboration(this.run, this.task)
                  ? ["research_checkpoint"]
                  : []),
              ]
            : []),
          "read_research_checkpoint",
          ...(this.run.kind === "writing" || this.run.kind === "research"
            ? ["check_writing"]
            : []),
          ...(isStructuredCollaboration(this.run, this.task)
            ? ["read_task_report"]
            : []),
          "report_context_issue",
        ].includes(tool.name),
      );
    return tools;
  }
  async evidence(): Promise<string> {
    const artifacts = authorizedSources(this.store, this.run, this.task);
    return canonical({
      sources: artifacts.map((a) => ({
        id: a.id,
        name: a.name,
        sha256: a.sha256,
        metadata: a.metadata,
      })),
      checks: this.run.checks,
    });
  }
  async validateArtifacts(paths: string[]): Promise<void> {
    for (const path of paths) {
      const file = await this.file(path);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.size === 0)
        throw new AgentError(
          "ARTIFACT_MISSING",
          `Empty or missing artifact: ${path}`,
        );
    }
  }
}

const checkpointSchema = z.strictObject({
  summary: z.string().min(1).max(8000),
  searchedScopes: z.array(z.string().min(1).max(500)).max(50),
  openQuestions: z.array(z.string().min(1).max(1000)).max(50),
  decisions: z
    .array(
      z.strictObject({
        text: z.string().min(1).max(2000),
        sourceIds: z.array(z.string().regex(/^[a-f0-9-]{36}$/)).max(50),
      }),
    )
    .max(50),
});

function parseDiscoveries(
  text: string,
  response: PublicFetchResult,
  limit: number,
  allowedHosts: string[],
): Array<{
  title: string;
  url: string;
  snippet?: string;
  fetchAllowed: boolean;
}> {
  let entries: unknown[] = [];
  if (response.mediaType === "application/json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AgentError(
        "SEARCH_RESPONSE",
        "Search response is not valid JSON",
      );
    }
    const root = parsed as { results?: unknown };
    entries = Array.isArray(root?.results) ? root.results : [];
  } else if (response.mediaType === "text/html") {
    const metadata = decodeResponse(response, 200_000).metadata;
    const links = Array.isArray(metadata.links)
      ? (metadata.links as unknown[])
      : [];
    entries = links;
  } else {
    throw new AgentError(
      "SEARCH_RESPONSE",
      "Configured search endpoint must return JSON results or HTML",
    );
  }
  const results: Array<{
    title: string;
    url: string;
    snippet?: string;
    fetchAllowed: boolean;
  }> = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const rawUrl = typeof value.url === "string" ? value.url : undefined;
    if (!rawUrl) continue;
    let url: URL;
    try {
      url = new URL(rawUrl, response.url);
    } catch {
      continue;
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== "443") ||
      url.protocol !== "https:"
    )
      continue;
    results.push({
      title:
        typeof value.title === "string"
          ? value.title.slice(0, 500)
          : typeof value.text === "string"
            ? value.text.slice(0, 500)
            : "Untitled discovery",
      url: url.href,
      snippet:
        typeof value.snippet === "string"
          ? value.snippet.slice(0, 2000)
          : typeof value.content === "string"
            ? value.content.slice(0, 2000)
            : undefined,
      fetchAllowed: allowedHosts.includes(url.hostname),
    });
    if (results.length >= limit) break;
  }
  return results;
}
