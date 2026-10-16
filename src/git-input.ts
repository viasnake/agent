import { spawn } from "node:child_process";
import type { Paths } from "./config.js";
import { AgentError, type PreparedInput } from "./types.js";
import { storePreparedText } from "./documents.js";
import { isImagePath } from "./images.js";
import { secretPath } from "./workspace.js";

const commitHash = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const outputLimit = 5_000_000;

export interface GitInputSelection {
  name: string;
  command: string;
  raw: Buffer;
  text: string;
  locator: string;
  partial: boolean;
}

export async function prepareGitInput(
  paths: Paths,
  workspace: string,
  selector: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<PreparedInput> {
  return storeGitInput(
    paths,
    await selectGitInput(workspace, selector, maxBytes, signal),
  );
}

export async function selectGitInput(
  workspace: string,
  selector: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<GitInputSelection> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new AgentError("INPUT_SIZE", "Git input budget is exhausted");
  const command = selector.slice("git:".length);
  let text: string,
    locator: string,
    partial = false;
  if (command === "status") {
    const [branch, summary, recent] = await Promise.all([
      git(workspace, ["branch", "--show-current"], signal, 4096),
      git(
        workspace,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        signal,
        100_000,
      ),
      git(workspace, ["log", "-5", "--oneline", "--no-color"], signal, 8192),
    ]);
    const entries = porcelainEntries(summary);
    rejectSecretPaths(entries.map((entry) => entry.path));
    text = `branch: ${branch.trim() || "(detached)"}\nstatus:\n${entries.map((entry) => `  ${entry.code} ${JSON.stringify(entry.path)}`).join("\n") || "  clean"}\nrecent commits:\n${recent.trim()}`;
    locator = "read-only branch/status/recent-commit summary";
  } else {
    const spec =
      command === "working" || command === "staged"
        ? command
        : command.startsWith("commit:")
          ? command.slice("commit:".length)
          : command;
    const range =
      /^([a-f0-9]{40}(?:[a-f0-9]{24})?)\.\.([a-f0-9]{40}(?:[a-f0-9]{24})?)$/i.exec(
        spec,
      );
    let args: string[], commits: string;
    if (spec === "working") {
      commits = await resolveCommit(workspace, "HEAD", signal);
      args = [
        "diff",
        commits,
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--binary",
      ];
    } else if (spec === "staged") {
      commits = await resolveCommit(workspace, "HEAD", signal);
      args = [
        "diff",
        "--cached",
        commits,
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--binary",
      ];
    } else if (range) {
      const from = await resolveCommit(workspace, range[1]!, signal),
        to = await resolveCommit(workspace, range[2]!, signal);
      commits = `${from}..${to}`;
      args = [
        "diff",
        `${from}..${to}`,
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--binary",
      ];
    } else if (commitHash.test(spec)) {
      const commit = await resolveCommit(workspace, spec, signal);
      commits = commit;
      args = [
        "show",
        "--format=fuller",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--binary",
        commit,
      ];
    } else {
      throw new AgentError(
        "GIT_SELECTOR",
        "Use @git:working, @git:staged, @git:status, @git:commit:<full-hash>, or @git:<full-hash>..<full-hash>",
      );
    }
    const changed = await git(
      workspace,
      [...nameArgs(spec, range, commits), "-z"],
      signal,
      100_000,
    );
    rejectSecretPaths(changed.split("\0").filter(Boolean));
    const changedPaths = changed.split("\0").filter(Boolean);
    const pathsInDiff = changedPaths.filter((path) => !isImagePath(path));
    const omittedImages = changedPaths.filter(isImagePath);
    partial = omittedImages.length > 0;
    if (!pathsInDiff.length)
      text = partial
        ? `[PARTIAL: image-only changes omitted from Git diff: ${omittedImages.map((path) => JSON.stringify(path)).join(", ")}]`
        : "";
    else {
      rejectSecretPaths(pathsInDiff);
      text = await git(
        workspace,
        ["--literal-pathspecs", ...args, "--", ...pathsInDiff],
        signal,
        Math.min(outputLimit, maxBytes),
      );
      if (partial)
        text += `\n[PARTIAL: image paths omitted from Git diff: ${omittedImages.map((path) => JSON.stringify(path)).join(", ")}]`;
    }
    locator = `read-only Git ${command}; commits ${commits}${partial ? `; image paths omitted: ${omittedImages.map((path) => JSON.stringify(path)).join(", ")}` : ""}`;
  }
  if (Buffer.byteLength(text) > maxBytes)
    throw new AgentError(
      "INPUT_SIZE",
      "Git input exceeds the configured input limit",
    );
  return {
    name: `git-${command.replace(/[^a-z0-9.-]/gi, "_")}.txt`,
    command,
    raw: Buffer.from(text),
    text,
    locator,
    partial,
  };
}

export async function storeGitInput(
  paths: Paths,
  selection: GitInputSelection,
): Promise<PreparedInput> {
  return storePreparedText(
    paths,
    selection.name,
    "git",
    selection.command,
    selection.raw,
    selection.text,
    selection.locator,
    selection.partial,
  );
}

export async function readGitStatus(
  workspace: string,
  signal = AbortSignal.timeout(30000),
): Promise<string> {
  const [branch, status, recent] = await Promise.all([
    git(workspace, ["branch", "--show-current"], signal, 4096),
    git(
      workspace,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      signal,
      100_000,
    ),
    git(workspace, ["log", "-5", "--oneline", "--no-color"], signal, 8192),
  ]);
  const paths = porcelainPaths(status);
  rejectSecretPaths(paths);
  const entries = porcelainEntries(status);
  return [
    `branch: ${branch.trim() || "(detached)"}`,
    "status:",
    ...(entries.length
      ? entries.map((entry) => `  ${entry.code} ${JSON.stringify(entry.path)}`)
      : ["  clean"]),
    "recent commits:",
    recent.trim(),
  ].join("\n");
}

function nameArgs(
  spec: string,
  range: RegExpExecArray | null,
  commits: string,
): string[] {
  const prefix = ["--literal-pathspecs"];
  if (spec === "working")
    return [...prefix, "diff", commits, "--no-renames", "--name-only"];
  if (spec === "staged")
    return [
      ...prefix,
      "diff",
      "--cached",
      commits,
      "--no-renames",
      "--name-only",
    ];
  if (range) return [...prefix, "diff", commits, "--no-renames", "--name-only"];
  return [
    ...prefix,
    "show",
    "--format=",
    "--no-renames",
    "--name-only",
    commits,
  ];
}

function porcelainPaths(status: string): string[] {
  const records = status.split("\0").filter(Boolean),
    paths: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    paths.push(record.slice(3));
    if (/^[RC].|.[RC]$/.test(record.slice(0, 2)) && records[index + 1])
      paths.push(records[++index]!);
  }
  return paths;
}
function porcelainEntries(
  status: string,
): Array<{ code: string; path: string }> {
  const records = status.split("\0").filter(Boolean);
  const entries: Array<{ code: string; path: string }> = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    entries.push({ code: record.slice(0, 2), path: record.slice(3) });
    if (/^[RC].|.[RC]$/.test(record.slice(0, 2)) && records[index + 1])
      entries.push({ code: record.slice(0, 2), path: records[++index]! });
  }
  return entries;
}

function rejectSecretPaths(paths: string[]): void {
  const unsafe = paths.find((path) => secretPath(path));
  if (unsafe)
    throw new AgentError(
      "GIT_SECRET_PATH",
      `Git input includes a protected path: ${unsafe}`,
    );
}

async function resolveCommit(
  workspace: string,
  revision: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await git(
    workspace,
    ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
    signal,
    128,
  );
  const resolved = result.trim();
  if (!commitHash.test(resolved))
    throw new AgentError(
      "GIT_REF",
      "Git revision did not resolve to a full commit hash",
    );
  return resolved;
}

function git(
  workspace: string,
  args: string[],
  signal: AbortSignal,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(
      "git",
      [
        "-C",
        workspace,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "color.ui=false",
        "-c",
        "log.showSignature=false",
        "-c",
        "protocol.allow=never",
        "--no-pager",
        ...args,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? "/",
          LANG: "C",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_LAZY_FETCH: "1",
          GIT_ALLOW_PROTOCOL: "",
          GIT_PROTOCOL: "version=0",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    );
    const output: Buffer[] = [],
      errors: Buffer[] = [];
    let length = 0,
      settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(new AgentError("GIT_ABORTED", "Git input was cancelled"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new AgentError("GIT_TIMEOUT", "Git input exceeded 30 seconds"));
    }, 30000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > maxBytes) {
        child.kill("SIGKILL");
        finish(
          new AgentError(
            "GIT_LIMIT",
            "Git output exceeds the bounded input limit",
          ),
        );
      } else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(errors).length < 4096)
        errors.push(chunk.subarray(0, 4096));
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0)
        finish(
          new AgentError(
            "GIT_INPUT",
            Buffer.concat(errors).toString("utf8").trim() ||
              `git exited with ${code}`,
          ),
        );
      else finish(undefined, Buffer.concat(output, length).toString("utf8"));
    });
  });
}
