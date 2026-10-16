import { lstat, readFile, rm, mkdtemp } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import type { Config } from "./config.js";
import { AgentError, type Run, type Task, type ToolSpec } from "./types.js";
import { Store } from "./storage.js";
import { Sandbox } from "./sandbox.js";
import {
  atomicWrite,
  canonical,
  errorMessage,
  readText,
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
import { fetchPublic } from "./network.js";
import { readContextArchive } from "./context.js";

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
  ) {}
  wrap<S extends z.ZodObject>(
    name: string,
    description: string,
    schema: S,
    execute: (args: z.output<S>, signal: AbortSignal) => Promise<string>,
  ): ToolSpec {
    return {
      name,
      description,
      parameters: z.toJSONSchema(schema),
      execute: (args, signal) => {
        const action = this.queue.then(async () => {
          signal.throwIfAborted();
          this.store.assertLease(this.run.id, this.run.generation);
          const parsed = schema.safeParse(args);
          if (!parsed.success)
            throw new AgentError(
              "TOOL_ARGUMENTS",
              parsed.error.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; "),
            );
          const operation = this.store.prepare(
            this.run,
            this.task.id,
            name,
            parsed.data,
          );
          this.store.operation(this.run, operation, "dispatched");
          try {
            const result = await execute(parsed.data, signal);
            signal.throwIfAborted();
            const log = await this.store.artifact(
              this.run,
              `tool-${operation}.txt`,
              "report",
              result,
              { taskId: this.task.id, tool: name, operationId: operation },
            );
            this.store.operation(this.run, operation, "completed", log.id);
            return result;
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
              !rejected &&
              (signal.aborted || name === "shell" || name.startsWith("mcp_"));
            this.store.operation(
              this.run,
              operation,
              uncertain ? "unknown" : "failed",
              errorMessage(error),
            );
            throw error;
          }
        });
        this.queue = action.catch(() => {});
        return action;
      },
    };
  }
  private async file(path: string, write = false): Promise<string> {
    const projectedTarget = await safePath(this.root, path, true),
      normalized = relative(this.root, projectedTarget).split(sep).join("/"),
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
          const source = this.store
            .artifacts(this.run.id)
            .find((a) => a.id === args.id && a.kind === "source");
          if (!source)
            throw new AgentError(
              "SOURCE",
              "Source does not belong to this run",
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
    ];
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
          async (args, signal) => {
            if (this.task.role === "reviewer") {
              const scratch = await mkdtemp(
                join(this.store.runDir(this.run.id), "review-check-"),
              );
              try {
                await copyWorkspace(
                  this.root,
                  scratch,
                  this.config.limits.maxWorkspaceBytes,
                );
                return JSON.stringify(
                  await this.sandbox.execute(scratch, args.command, signal),
                );
              } finally {
                await rm(scratch, { recursive: true, force: true });
              }
            }
            return JSON.stringify(
              await this.sandbox.execute(
                this.root,
                args.command,
                signal,
                !this.task.write,
              ),
            );
          },
        ),
      );
    if (
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
            const result = await fetchPublic(
              new URL(args.url),
              AbortSignal.any([signal, AbortSignal.timeout(30000)]),
              this.config.web.allowedHosts,
              this.config.limits.maxFileBytes,
            );
            const source = await this.store.artifact(
              this.run,
              result.url,
              "source",
              result.text,
              {
                url: result.url,
                retrievedAt: new Date().toISOString(),
                contentType: result.contentType,
              },
            );
            const numbered = result.text
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
    if (this.run.access === "read-only")
      return tools.filter((tool) =>
        [
          "read_file",
          "read_source",
          "list_files",
          "search_files",
          "read_context",
        ].includes(tool.name),
      );
    return tools;
  }
  async evidence(): Promise<string> {
    const artifacts = this.store
      .artifacts(this.run.id)
      .filter((a) => a.kind === "source");
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
