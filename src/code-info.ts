import { Worker } from "node:worker_threads";
import { posix } from "node:path";
import { z } from "zod";
import { inventory } from "./workspace.js";
import { AgentError } from "./types.js";
import { canonical, sha256 } from "./util.js";
import { cleanEnvironment } from "./process.js";

export const codeInfoSchema = z.strictObject({
  action: z.enum(["definition", "references", "diagnostics"]),
  path: z.string().min(1).max(1000),
  line: z.number().int().min(1).max(1_000_000).default(1),
  column: z.number().int().min(1).max(1_000_000).default(1),
});
export type CodeInfoQuery = z.output<typeof codeInfoSchema>;
export interface CodeInfoInput {
  query: CodeInfoQuery;
  files: Array<{ path: string; text: string; sha256: string }>;
}
export interface CodeInfoResult {
  action: CodeInfoQuery["action"];
  configuration: "bounded-defaults-not-project-tsconfig";
  compilerVersion: string;
  sourceFiles: number;
  snapshotSha256: string;
  targetSha256: string;
  limitations: string[];
  results: Array<Record<string, unknown>>;
  truncated: boolean;
  libraryMatches: number;
}
type CodeInfoDetails = Pick<
  CodeInfoResult,
  "results" | "truncated" | "libraryMatches" | "compilerVersion"
>;

export async function inspectCode(
  root: string,
  query: CodeInfoQuery,
  maxWorkspaceBytes: number,
  read: (path: string) => Promise<Buffer>,
  signal: AbortSignal,
): Promise<CodeInfoResult> {
  signal.throwIfAborted();
  const deadline = Date.now() + 10000;
  const entries = await inventory(root, maxWorkspaceBytes, {
    maxFiles: 4000,
    deadline,
  });
  const sources = Object.entries(entries)
    .filter(([path]) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path))
    .sort(([a], [b]) => a.localeCompare(b));
  if (!sources.some(([path]) => path === query.path))
    throw new AgentError(
      "CODE_INFO_PATH",
      "Select a captured TypeScript or JavaScript source file",
    );
  if (sources.length > 512)
    throw new AgentError(
      "CODE_INFO_LIMIT",
      "Code information is limited to 512 source files",
    );
  const files: CodeInfoInput["files"] = [];
  let bytes = 0;
  for (const [path, entry] of sources) {
    signal.throwIfAborted();
    if (Date.now() >= deadline)
      throw new AgentError(
        "CODE_INFO_LIMIT",
        "Code capture exceeded its time limit",
      );
    if (
      path.includes("\\") ||
      posix.normalize(path) !== path ||
      path.startsWith("/") ||
      path.startsWith("../")
    )
      throw new AgentError(
        "CODE_INFO_PATH",
        "Source paths must be normalized relative paths",
      );
    bytes += entry.bytes;
    if (entry.bytes > 512_000 || bytes > 4_000_000)
      throw new AgentError(
        "CODE_INFO_LIMIT",
        "Code information is limited to 512KB per source and 4MB total",
      );
    const data = await read(path);
    if (data.length !== entry.bytes || sha256(data) !== entry.hash)
      throw new AgentError(
        "CODE_INFO_CHANGED",
        "Source changed during capture; request code information again",
      );
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        data,
      );
      if (text.includes("\0")) throw new Error();
    } catch {
      throw new AgentError(
        "CODE_INFO_ENCODING",
        "Code information requires UTF-8 text without NUL bytes",
      );
    }
    files.push({ path, text, sha256: entry.hash });
  }
  signal.throwIfAborted();
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw new AgentError(
      "CODE_INFO_LIMIT",
      "Code capture exceeded its time limit",
    );
  const input: CodeInfoInput = { files, query };
  const details = await new Promise<CodeInfoDetails>((resolve, reject) => {
    const worker = new Worker(
      new URL("./code-info-worker.js", import.meta.url),
      {
        workerData: input,
        env: cleanEnvironment,
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 256,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4,
        },
        stdout: true,
        stderr: true,
      },
    );
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (error?: AgentError, value?: CodeInfoDetails) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      void worker.terminate().then(
        () => {
          if (error) reject(error);
          else resolve(value!);
        },
        () =>
          reject(
            new AgentError(
              "CODE_INFO_UNAVAILABLE",
              "Code analysis worker could not stop",
            ),
          ),
      );
    };
    const abort = () =>
      finish(new AgentError("CANCELLED", "Code analysis cancelled"));
    const timer = setTimeout(
      () =>
        finish(
          new AgentError(
            "CODE_INFO_LIMIT",
            "Code analysis exceeded its time limit",
          ),
        ),
      remaining,
    );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    worker.once("error", () =>
      finish(
        new AgentError(
          "CODE_INFO_UNAVAILABLE",
          "Code analysis failed or exceeded its memory limit",
        ),
      ),
    );
    worker.once("exit", () =>
      finish(
        new AgentError(
          "CODE_INFO_UNAVAILABLE",
          "Code analysis ended without a result",
        ),
      ),
    );
    worker.once(
      "message",
      (message: { ok: boolean; result?: CodeInfoDetails; error?: string }) => {
        if (message.ok && message.result) finish(undefined, message.result);
        else
          finish(
            new AgentError(
              "CODE_INFO_UNAVAILABLE",
              message.error === "position"
                ? "Position must be within the selected source (1-based UTF-16 columns)"
                : "Code analysis could not complete",
            ),
          );
      },
    );
  });
  signal.throwIfAborted();
  return {
    ...details,
    action: query.action,
    configuration: "bounded-defaults-not-project-tsconfig",
    sourceFiles: files.length,
    snapshotSha256: sha256(
      canonical(files.map(({ path, sha256 }) => ({ path, sha256 }))),
    ),
    targetSha256: files.find((file) => file.path === query.path)!.sha256,
    limitations: [
      "Captured TypeScript/JavaScript source only; not a project build or passing-check verdict.",
      "Fixed ES2022, ESNext/Bundler, strict, allowJs/checkJs, JSX-preserve settings; project tsconfig, plugins, scripts and dependencies are not loaded.",
      "Bundled TypeScript standard libraries are available. Missing dependencies, path aliases and project-specific settings may change results.",
      "Positions use 1-based lines and UTF-16 columns; end positions are exclusive. Results describe the captured bytes, not later edits.",
    ],
  };
}
