import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import type { Paths } from "./config.js";
import { AgentError, type PreparedInput } from "./types.js";
import { storePreparedText } from "./documents.js";
import { isImagePath } from "./images.js";
import { secretPath } from "./workspace.js";
import { readBoundedFile, safePath } from "./util.js";

const commitHash = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const outputLimit = 5_000_000;
const maxContentBytes = 5_000_000;
const maxInspectedBytes = 50_000_000;
const maxTrackedPaths = 50_000;

export const gitComparisonNotice =
  "[NOTE: raw stored bytes are compared; Git clean/smudge filters, attributes, textconv and line-ending normalization are intentionally not applied.]";

export interface GitInputSelection {
  name: string;
  command: string;
  raw: Buffer;
  text: string;
  locator: string;
  partial: boolean;
}

interface Entry {
  mode: string;
  oid: string;
  type: string;
}

interface Omission {
  path: string;
  reason: string;
}

class Budget {
  private inspected = 0;
  readonly blobs = new Map<string, Buffer>();
  constructor(
    private readonly signal: AbortSignal,
    readonly objectFormat: "sha1" | "sha256",
  ) {}
  check(): void {
    this.signal.throwIfAborted();
  }
  charge(bytes: number): void {
    this.inspected += bytes;
    if (this.inspected > maxInspectedBytes)
      throw new AgentError(
        "GIT_LIMIT",
        "Git input exceeds the cumulative inspected content limit",
      );
  }
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
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const command = selector.slice("git:".length);
  const root = await repositoryRoot(workspace, boundedSignal);
  const budget = new Budget(
    boundedSignal,
    await hashFormat(root, boundedSignal),
  );
  let text: string,
    locator: string,
    partial = false;
  if (command === "status") {
    const status = await statusReport(root, boundedSignal, budget);
    text = status.text;
    locator = "read-only branch/status/recent-commit summary";
    partial = status.partial;
  } else {
    const spec = command.startsWith("commit:")
      ? command.slice("commit:".length)
      : command;
    const range =
      /^([a-f0-9]{40}(?:[a-f0-9]{24})?)\.\.([a-f0-9]{40}(?:[a-f0-9]{24})?)$/i.exec(
        spec,
      );
    let comparison: Comparison;
    if (spec === "working" || spec === "staged")
      comparison = await worktreeComparison(root, spec, boundedSignal, budget);
    else if (range)
      comparison = await commitComparison(
        root,
        await resolveCommit(root, range[1]!, boundedSignal),
        await resolveCommit(root, range[2]!, boundedSignal),
        boundedSignal,
        budget,
      );
    else if (commitHash.test(spec)) {
      const commit = await resolveCommit(root, spec, boundedSignal);
      const parent = await firstParent(root, commit, boundedSignal);
      comparison = await commitComparison(
        root,
        parent,
        commit,
        boundedSignal,
        budget,
      );
      comparison.label = parent
        ? `${parent}..${commit} (first parent)`
        : `${commit} (root commit against the empty tree)`;
      comparison.metadata = await commitMetadata(root, commit, boundedSignal);
    } else
      throw new AgentError(
        "GIT_SELECTOR",
        "Use @git:working, @git:staged, @git:status, @git:commit:<full-hash>, or @git:<full-hash>..<full-hash>",
      );
    const rendered = renderComparison(command, comparison);
    text = rendered.text;
    locator = rendered.locator;
    partial = rendered.partial;
  }
  if (Buffer.byteLength(text) > Math.min(outputLimit, maxBytes))
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
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const root = await repositoryRoot(workspace, boundedSignal);
  const status = await statusReport(
    root,
    boundedSignal,
    new Budget(boundedSignal, await hashFormat(root, boundedSignal)),
  );
  return status.text;
}

interface Change {
  path: string;
  before?: { mode: string; content?: Buffer };
  after?: { mode: string; content?: Buffer };
}
interface WorktreeFile {
  mode: string;
  oid?: string;
  content?: Buffer;
}

interface Comparison {
  label: string;
  metadata?: string;
  changes: Change[];
  omitted: Omission[];
  unmerged: string[];
  untracked: string[];
}

async function statusReport(
  root: string,
  signal: AbortSignal,
  budget: Budget,
): Promise<{ text: string; partial: boolean }> {
  const head = await resolveHead(root, signal);
  const tree = head ? await treeEntries(root, head, signal) : new Map();
  const index = await indexEntries(root, signal);
  const untracked = await untrackedPaths(root, signal);
  enforcePathCount([
    ...tree.keys(),
    ...index.entries.keys(),
    ...index.unmerged,
    ...untracked,
  ]);
  rejectSecretPaths([
    ...new Set([
      ...tree.keys(),
      ...index.entries.keys(),
      ...index.unmerged,
      ...untracked,
    ]),
  ]);
  const lines: string[] = [];
  const omitted: Omission[] = [];
  for (const path of [
    ...new Set([...tree.keys(), ...index.entries.keys()]),
  ].sort()) {
    if (index.unmerged.includes(path)) continue;
    const staged = tree.get(path),
      indexed = index.entries.get(path);
    const x = !staged
      ? "A"
      : !indexed
        ? "D"
        : staged.oid !== indexed.oid || staged.mode !== indexed.mode
          ? "M"
          : " ";
    let y = " ";
    if (indexed) {
      if (indexed.type !== "blob") {
        omitted.push({
          path,
          reason: `unsupported entry type ${indexed.type}`,
        });
        y = "?";
      } else if (isImagePath(path)) {
        const current = await worktreeFile(root, path, budget, false);
        y = current ? "?" : "D";
        omitted.push({ path, reason: "image content not inspected" });
      } else {
        const current = await worktreeFile(root, path, budget);
        y = !current
          ? "D"
          : current.oid !== indexed.oid || current.mode !== indexed.mode
            ? "M"
            : " ";
      }
    }
    if (x !== " " || y !== " ") lines.push(`  ${x}${y} ${quote(path)}`);
  }
  for (const path of index.unmerged.sort())
    lines.push(`  UU ${quote(path)} (unmerged; stages are not inspected)`);
  for (const path of untracked.sort())
    lines.push(`  ?? ${quote(path)} (untracked; content is not inspected)`);
  const recent = head ? await recentCommits(root, signal) : "";
  const text = [
    `branch: ${(await branchName(root, signal)) || "(detached)"}`,
    "status:",
    ...(lines.length ? lines : ["  clean"]),
    ...(omitted.length
      ? [
          "not inspected:",
          ...omitted.map((item) => `  ${quote(item.path)}: ${item.reason}`),
        ]
      : []),
    "recent commits:",
    recent || "  (none)",
    gitComparisonNotice,
  ].join("\n");
  if (Buffer.byteLength(text) > outputLimit)
    throw new AgentError("GIT_LIMIT", "Git status exceeds the output limit");
  return {
    text,
    partial: omitted.length > 0 || index.unmerged.length > 0,
  };
}

async function worktreeComparison(
  root: string,
  spec: "working" | "staged",
  signal: AbortSignal,
  budget: Budget,
): Promise<Comparison> {
  const head = await resolveHead(root, signal);
  const tree = head ? await treeEntries(root, head, signal) : new Map();
  const index = await indexEntries(root, signal);
  const untracked = await untrackedPaths(root, signal);
  enforcePathCount([
    ...tree.keys(),
    ...index.entries.keys(),
    ...index.unmerged,
    ...untracked,
  ]);
  const comparison: Comparison = {
    label: head
      ? `${spec} changes against ${head}`
      : `${spec} changes against the empty tree (unborn HEAD)`,
    changes: [],
    omitted: [],
    unmerged: index.unmerged,
    untracked,
  };
  rejectSecretPaths([
    ...new Set([
      ...tree.keys(),
      ...index.entries.keys(),
      ...index.unmerged,
      ...untracked,
    ]),
  ]);
  for (const path of [
    ...new Set([...tree.keys(), ...index.entries.keys()]),
  ].sort()) {
    if (index.unmerged.includes(path)) continue;
    const before = tree.get(path);
    const indexed = index.entries.get(path);
    if (isImagePath(path)) {
      comparison.omitted.push({ path, reason: "image content omitted" });
      continue;
    }
    const after =
      spec === "staged"
        ? indexed
        : indexed
          ? await worktreeFile(root, path, budget)
          : undefined;
    if (before?.oid === after?.oid && before?.mode === after?.mode) continue;
    if (before && before.type !== "blob") {
      comparison.omitted.push({
        path,
        reason: `unsupported entry type ${before.type}`,
      });
      continue;
    }
    if (after && indexed && indexed.type !== "blob") {
      comparison.omitted.push({
        path,
        reason: `unsupported entry type ${indexed.type}`,
      });
      continue;
    }
    const beforeContent = before
      ? await blobContent(root, before.oid, signal, budget)
      : undefined;
    const afterContent = after
      ? spec === "staged"
        ? await blobContent(root, indexed!.oid, signal, budget)
        : "content" in after && after.content
          ? {
              data: after.content,
              text: decodeText(after.content) !== undefined,
            }
          : undefined
      : undefined;
    if (
      (beforeContent && !beforeContent.text) ||
      (afterContent && !afterContent.text)
    ) {
      comparison.omitted.push({
        path,
        reason: "binary or non-UTF-8 content omitted",
      });
      continue;
    }
    comparison.changes.push({
      path,
      ...(before
        ? { before: { mode: before.mode, content: beforeContent?.data } }
        : {}),
      ...(after
        ? { after: { mode: after.mode, content: afterContent?.data } }
        : {}),
    });
  }
  return comparison;
}

async function commitComparison(
  root: string,
  from: string | undefined,
  to: string,
  signal: AbortSignal,
  budget: Budget,
): Promise<Comparison> {
  const before = from ? await treeEntries(root, from, signal) : new Map();
  const after = await treeEntries(root, to, signal);
  enforcePathCount([...before.keys(), ...after.keys()]);
  const comparison: Comparison = {
    label: from
      ? `${from}..${to}`
      : `${to} (root commit against the empty tree)`,
    changes: [],
    omitted: [],
    unmerged: [],
    untracked: [],
  };
  rejectSecretPaths([...new Set([...before.keys(), ...after.keys()])]);
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const previous = before.get(path),
      current = after.get(path);
    if (
      previous?.oid === current?.oid &&
      previous?.mode === current?.mode &&
      !isImagePath(path)
    )
      continue;
    const unsupported = [previous, current].find(
      (entry) => entry && entry.type !== "blob",
    );
    if (unsupported) {
      comparison.omitted.push({
        path,
        reason: `unsupported entry type ${unsupported.type}`,
      });
      continue;
    }
    if (isImagePath(path)) {
      comparison.omitted.push({ path, reason: "image content omitted" });
      continue;
    }
    const previousContent = previous
      ? await blobContent(root, previous.oid, signal, budget)
      : undefined;
    const currentContent = current
      ? await blobContent(root, current.oid, signal, budget)
      : undefined;
    if (
      (previousContent && !previousContent.text) ||
      (currentContent && !currentContent.text)
    ) {
      comparison.omitted.push({
        path,
        reason: "binary or non-UTF-8 content omitted",
      });
      continue;
    }
    comparison.changes.push({
      path,
      ...(previous
        ? { before: { mode: previous.mode, content: previousContent?.data } }
        : {}),
      ...(current
        ? { after: { mode: current.mode, content: currentContent?.data } }
        : {}),
    });
  }
  return comparison;
}

function renderComparison(
  command: string,
  comparison: Comparison,
): { text: string; locator: string; partial: boolean } {
  const sections: string[] = [];
  if (comparison.metadata) sections.push(comparison.metadata);
  for (const change of comparison.changes) {
    const header =
      change.before && change.after && change.before.mode !== change.after.mode
        ? `mode ${change.before.mode} => ${change.after.mode} ${quote(change.path)}`
        : !change.before
          ? `new file mode ${change.after!.mode} ${quote(change.path)}`
          : !change.after
            ? `deleted file mode ${change.before.mode} ${quote(change.path)}`
            : `modified ${quote(change.path)}`;
    const patch = createTwoFilesPatch(
      change.before ? "a/file" : "/dev/null",
      change.after ? "b/file" : "/dev/null",
      change.before?.content?.toString("utf8") ?? "",
      change.after?.content?.toString("utf8") ?? "",
      undefined,
      undefined,
      { context: 3 },
    );
    sections.push(`${header}\n${patch}`);
  }
  const notes: string[] = [];
  const imageOmissions = comparison.omitted.filter((item) =>
    item.reason.includes("image"),
  );
  const otherOmissions = comparison.omitted.filter(
    (item) => !item.reason.includes("image"),
  );
  if (imageOmissions.length)
    notes.push(
      `[PARTIAL: ${comparison.changes.length ? "image paths omitted from Git diff" : "image-only changes omitted from Git diff"}: ${imageOmissions
        .map((item) => quote(item.path))
        .join(", ")}]`,
    );
  if (otherOmissions.length)
    notes.push(
      `[PARTIAL: content not inspected: ${otherOmissions
        .map((item) => `${quote(item.path)} (${item.reason})`)
        .join(", ")}]`,
    );
  if (comparison.unmerged.length)
    notes.push(
      `[PARTIAL: unmerged paths are not inspected: ${comparison.unmerged
        .map(quote)
        .join(", ")}]`,
    );
  if (comparison.untracked.length)
    notes.push(
      `[NOTE: untracked files are listed by name only and are not part of this selection: ${comparison.untracked
        .map(quote)
        .join(", ")}]`,
    );
  if (!comparison.changes.length && !comparison.metadata)
    notes.unshift(
      comparison.omitted.length
        ? "[PARTIAL: every change in this selection was omitted from the text comparison.]"
        : "[No text changes in this selection.]",
    );
  const partial =
    comparison.omitted.length > 0 || comparison.unmerged.length > 0;
  return {
    text: [...sections, ...notes, gitComparisonNotice].join("\n"),
    locator: `read-only Git ${command}; ${comparison.label}${
      comparison.omitted.length
        ? `; omitted: ${comparison.omitted.map((item) => quote(item.path)).join(", ")}`
        : ""
    }`,
    partial,
  };
}

function quote(path: string): string {
  return JSON.stringify(path);
}

function rejectSecretPaths(paths: string[]): void {
  const unsafe = paths.find((path) => secretPath(path));
  if (unsafe)
    throw new AgentError(
      "GIT_SECRET_PATH",
      `Git input includes a protected path: ${unsafe}`,
    );
}

function enforcePathCount(paths: string[]): void {
  if (new Set(paths).size > maxTrackedPaths)
    throw new AgentError("GIT_LIMIT", "Git input exceeds the path limit");
}

function blobOid(data: Buffer, objectFormat: "sha1" | "sha256"): string {
  return createHash(objectFormat)
    .update(`blob ${data.length}\0`)
    .update(data)
    .digest("hex");
}

function decodeText(data: Buffer): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

function decodeUtf8(data: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new AgentError("GIT_INPUT", "Git metadata contains invalid UTF-8");
  }
}

function decodePath(data: Buffer): string {
  const path = decodeUtf8(data);
  validateGitPath(path);
  return path;
}

function nulRecords(data: Buffer): Buffer[] {
  if (!data.length) return [];
  if (data[data.length - 1] !== 0)
    throw new AgentError("GIT_INPUT", "Git metadata is not NUL terminated");
  const records: Buffer[] = [];
  let start = 0;
  for (let offset = 0; offset < data.length; offset++) {
    if (data[offset] === 0) {
      if (offset === start)
        throw new AgentError(
          "GIT_INPUT",
          "Git metadata contains an empty record",
        );
      records.push(data.subarray(start, offset));
      start = offset + 1;
    }
  }
  return records;
}

function validateGitPath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path
      .split("/")
      .some((component) => ["", ".", "..", ".git"].includes(component))
  )
    throw new AgentError("GIT_INPUT", "Git metadata contains an unsafe path");
}

async function worktreeFile(
  root: string,
  path: string,
  budget: Budget,
  readContent = true,
): Promise<WorktreeFile | undefined> {
  budget.check();
  try {
    const safe = await safePath(root, path);
    const stat = await lstat(safe);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new AgentError(
        "GIT_INPUT",
        `Tracked worktree path is not a safe regular file: ${path}`,
      );
    const mode = (stat.mode & 0o111) !== 0 ? "100755" : "100644";
    if (!readContent) return { mode };
    const content = await readBoundedFile(safe, maxContentBytes);
    const after = await lstat(safe);
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs
    )
      throw new AgentError(
        "GIT_INPUT",
        `Working file changed while it was inspected: ${path}`,
      );
    budget.charge(content.length);
    return {
      mode,
      oid: blobOid(content, budget.objectFormat),
      content,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function blobContent(
  root: string,
  oid: string,
  signal: AbortSignal,
  budget: Budget,
): Promise<{ data: Buffer; text: boolean }> {
  budget.check();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(oid))
    throw new AgentError("GIT_INPUT", "Git object id is not a full hash");
  let data = budget.blobs.get(oid);
  if (!data) {
    data = await gitBytes(
      root,
      ["cat-file", "blob", oid],
      signal,
      maxContentBytes,
    );
    budget.charge(data.length);
    budget.blobs.set(oid, data);
  }
  return { data, text: decodeText(data) !== undefined };
}

async function treeEntries(
  root: string,
  commit: string,
  signal: AbortSignal,
): Promise<Map<string, Entry>> {
  const output = await gitBytes(
    root,
    ["ls-tree", "-r", "-z", "--full-tree", commit],
    signal,
    outputLimit,
  );
  const entries = new Map<string, Entry>();
  for (const record of nulRecords(output)) {
    const separator = record.indexOf(9);
    const header =
      separator >= 0 ? record.subarray(0, separator) : Buffer.alloc(0);
    const path =
      separator >= 0 ? decodePath(record.subarray(separator + 1)) : "";
    const headerText = decodeUtf8(header);
    const [mode, type, oid] = headerText.split(" ");
    if (!mode || !type || !oid || !path || !commitHash.test(oid))
      throw new AgentError("GIT_INPUT", "Git tree entry is malformed");
    validateGitPath(path);
    if (entries.size >= maxTrackedPaths)
      throw new AgentError("GIT_LIMIT", "Git tree exceeds the path limit");
    if (entries.has(path))
      throw new AgentError("GIT_INPUT", "Git tree contains a duplicate path");
    entries.set(path, { mode, type, oid });
  }
  return entries;
}

async function indexEntries(
  root: string,
  signal: AbortSignal,
): Promise<{ entries: Map<string, Entry>; unmerged: string[] }> {
  const output = await gitBytes(
    root,
    ["ls-files", "--stage", "-z", "--full-name"],
    signal,
    outputLimit,
  );
  const entries = new Map<string, Entry>(),
    unmerged = new Set<string>();
  const records = nulRecords(output);
  if (records.length > maxTrackedPaths)
    throw new AgentError("GIT_LIMIT", "Git index exceeds the path limit");
  for (const record of records) {
    const separator = record.indexOf(9);
    const header =
      separator >= 0 ? decodeUtf8(record.subarray(0, separator)) : "";
    const path =
      separator >= 0 ? decodePath(record.subarray(separator + 1)) : "";
    const [mode, oid, stage] = header.split(/\s+/);
    if (!mode || !oid || !stage || !path || !commitHash.test(oid))
      throw new AgentError("GIT_INPUT", "Git index entry is malformed");
    validateGitPath(path);
    if (!["0", "1", "2", "3"].includes(stage))
      throw new AgentError("GIT_INPUT", "Git index stage is unsupported");
    if (entries.size >= maxTrackedPaths)
      throw new AgentError("GIT_LIMIT", "Git index exceeds the path limit");
    if (stage !== "0") {
      unmerged.add(path);
      entries.delete(path);
      continue;
    }
    if (!unmerged.has(path))
      entries.set(path, {
        mode,
        oid,
        type:
          mode === "160000"
            ? "commit"
            : mode === "120000"
              ? "link"
              : mode === "040000"
                ? "tree"
                : "blob",
      });
  }
  return { entries, unmerged: [...unmerged] };
}

async function untrackedPaths(
  root: string,
  signal: AbortSignal,
): Promise<string[]> {
  const output = await gitBytes(
    root,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    signal,
    outputLimit,
  );
  const paths = nulRecords(output).map(decodePath);
  for (const path of paths) validateGitPath(path);
  if (paths.length > maxTrackedPaths)
    throw new AgentError("GIT_LIMIT", "Git untracked paths exceed the limit");
  return paths;
}

async function hashFormat(
  root: string,
  signal: AbortSignal,
): Promise<"sha1" | "sha256"> {
  const format = (
    await gitText(root, ["rev-parse", "--show-object-format"], signal, 32)
  ).trim();
  if (format !== "sha1" && format !== "sha256")
    throw new AgentError(
      "GIT_INPUT",
      `Unsupported Git object format: ${format}`,
    );
  return format;
}

async function branchName(
  root: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const result = await gitTry(
    root,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    signal,
    4096,
  );
  if (result.code === 0) return decodeUtf8(result.stdout).trim();
  if (result.code !== 1)
    throw new AgentError(
      "GIT_REF",
      result.stderr.trim() || "Unable to read branch",
    );
  return undefined;
}

async function recentCommits(
  root: string,
  signal: AbortSignal,
): Promise<string> {
  return gitText(
    root,
    [
      "log",
      "-5",
      "--no-patch",
      "--no-show-signature",
      "--no-color",
      "--format=  %H %s",
    ],
    signal,
    outputLimit,
  ).then((text) => text.trimEnd());
}

async function commitMetadata(
  root: string,
  commit: string,
  signal: AbortSignal,
): Promise<string> {
  const output = await gitText(
    root,
    [
      "log",
      "-1",
      "--no-patch",
      "--no-show-signature",
      "--no-color",
      "--format=commit %H%nAuthor: %an <%ae>%nAuthorDate: %aI%nCommit: %cn <%ce>%nCommitDate: %cI%n%n%B",
      commit,
    ],
    signal,
    100_000,
  );
  return output.trimEnd();
}

async function resolveHead(
  root: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const rawHead = await gitTry(
    root,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD"],
    signal,
    128,
  );
  if (rawHead.code === 0) {
    const raw = decodeUtf8(rawHead.stdout).trim();
    if (!commitHash.test(raw))
      throw new AgentError(
        "GIT_REF",
        "HEAD did not resolve to a full object id",
      );
    const result = await gitTry(
      root,
      ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"],
      signal,
      128,
    );
    if (result.code !== 0)
      throw new AgentError(
        "GIT_REF",
        result.stderr.trim() || "HEAD does not resolve to an available commit",
      );
    const resolved = decodeUtf8(result.stdout).trim();
    if (!commitHash.test(resolved))
      throw new AgentError("GIT_REF", "HEAD did not resolve to a full commit");
    return resolved;
  }
  if (rawHead.code !== 1)
    throw new AgentError(
      "GIT_REF",
      rawHead.stderr.trim() || "Unable to resolve HEAD",
    );
  const symbolic = await gitTry(
    root,
    ["symbolic-ref", "--quiet", "HEAD"],
    signal,
    4096,
  );
  if (symbolic.code === 0) return undefined;
  if (symbolic.code !== 1)
    throw new AgentError(
      "GIT_REF",
      "HEAD cannot be resolved; the repository may be corrupt or detached at a missing object",
    );
  throw new AgentError(
    "GIT_REF",
    "HEAD cannot be resolved; the repository may be corrupt or detached at a missing object",
  );
}

async function resolveCommit(
  root: string,
  revision: string,
  signal: AbortSignal,
): Promise<string> {
  if (!commitHash.test(revision))
    throw new AgentError("GIT_REF", "Git revisions must be full object hashes");
  const resolved = (
    await gitText(
      root,
      ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
      signal,
      128,
    )
  ).trim();
  if (!commitHash.test(resolved))
    throw new AgentError(
      "GIT_REF",
      "Git revision did not resolve to a full commit hash",
    );
  return resolved;
}

async function firstParent(
  root: string,
  commit: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const output = await gitText(
    root,
    ["log", "-1", "--no-patch", "--no-show-signature", "--format=%P", commit],
    signal,
    4096,
  );
  const parent = output.trim().split(/\s+/)[0];
  if (!parent) return undefined;
  if (!commitHash.test(parent))
    throw new AgentError("GIT_REF", "Parent did not resolve to a full commit");
  return resolveCommit(root, parent, signal);
}

async function repositoryRoot(
  workspace: string,
  signal: AbortSignal,
): Promise<string> {
  const output = await gitText(
    workspace,
    ["rev-parse", "--show-toplevel"],
    signal,
    8192,
  );
  const toplevel = output.endsWith("\n") ? output.slice(0, -1) : output;
  if (!toplevel)
    throw new AgentError(
      "GIT_WORKSPACE",
      "Git input requires a repository working tree",
    );
  let requested: string, actual: string;
  try {
    [requested, actual] = await Promise.all([
      realpath(workspace),
      realpath(toplevel),
    ]);
  } catch {
    throw new AgentError(
      "GIT_WORKSPACE",
      `Git reports an inaccessible worktree at ${toplevel}; check core.worktree and the configured workspace`,
    );
  }
  if (requested !== actual)
    throw new AgentError(
      "GIT_WORKSPACE",
      `Git input requires the repository top level: configure the workspace as ${actual}`,
    );
  return actual;
}

async function gitText(
  root: string,
  args: string[],
  signal: AbortSignal,
  maxBytes: number,
): Promise<string> {
  return decodeUtf8(await gitBytes(root, args, signal, maxBytes));
}

async function gitBytes(
  root: string,
  args: string[],
  signal: AbortSignal,
  maxBytes: number,
): Promise<Buffer> {
  const result = await gitTry(root, args, signal, maxBytes);
  if (result.code !== 0)
    throw new AgentError(
      "GIT_INPUT",
      result.stderr.trim() || `git exited with ${result.code}`,
    );
  return result.stdout;
}

function gitTry(
  workspace: string,
  args: string[],
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(
      "git",
      [
        "-C",
        workspace,
        "-c",
        "core.fsmonitor=/bin/false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.useReplaceRefs=false",
        "-c",
        "color.ui=false",
        "-c",
        "log.showSignature=false",
        "-c",
        "protocol.allow=never",
        "--no-pager",
        "--no-replace-objects",
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
          GIT_NO_REPLACE_OBJECTS: "1",
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
    const finish = (
      error?: Error,
      value?: { code: number; stdout: Buffer; stderr: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value!);
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
    child.on("close", (code) =>
      finish(undefined, {
        code: code ?? 1,
        stdout: Buffer.concat(output, length),
        stderr: Buffer.concat(errors).toString("utf8"),
      }),
    );
  });
}
