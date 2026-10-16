import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
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
const operationTimeoutMs = 30_000;

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
  objectFormat: "sha1" | "sha256" = "sha1";
  constructor(
    readonly signal: AbortSignal,
    readonly deadline: number,
  ) {}
  check(): void {
    if (performance.now() >= this.deadline)
      throw new AgentError("GIT_TIMEOUT", "Git input exceeded 30 seconds");
    this.signal.throwIfAborted();
  }
  remainingMs(): number {
    this.check();
    return Math.max(1, Math.ceil(this.deadline - performance.now()));
  }
  charge(bytes: number): void {
    this.check();
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
  const deadline = performance.now() + operationTimeoutMs;
  const budget = new Budget(signal, deadline);
  budget.check();
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new AgentError("INPUT_SIZE", "Git input budget is exhausted");
  const command = selector.slice("git:".length);
  const root = await repositoryRoot(workspace, budget);
  await hashFormat(root, budget);
  let text: string,
    locator: string,
    partial = false;
  if (command === "status") {
    const status = await statusReport(root, budget);
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
      comparison = await worktreeComparison(root, spec, budget);
    else if (range)
      comparison = await commitComparison(
        root,
        await resolveCommit(root, range[1]!, budget),
        await resolveCommit(root, range[2]!, budget),
        budget,
      );
    else if (commitHash.test(spec)) {
      const commit = await resolveCommit(root, spec, budget);
      const parent = await firstParent(root, commit, budget);
      comparison = await commitComparison(root, parent, commit, budget);
      comparison.label = parent
        ? `${parent}..${commit} (first parent)`
        : `${commit} (root commit against the empty tree)`;
      comparison.metadata = await commitMetadata(root, commit, budget);
    } else
      throw new AgentError(
        "GIT_SELECTOR",
        "Use @git:working, @git:staged, @git:status, @git:commit:<full-hash>, or @git:<full-hash>..<full-hash>",
      );
    const rendered = await renderComparison(
      command,
      comparison,
      budget,
      maxBytes,
    );
    text = rendered.text;
    locator = rendered.locator;
    partial = rendered.partial;
  }
  budget.check();
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
  signal = new AbortController().signal,
): Promise<string> {
  const budget = new Budget(signal, performance.now() + operationTimeoutMs);
  budget.check();
  const root = await repositoryRoot(workspace, budget);
  await hashFormat(root, budget);
  const status = await statusReport(root, budget);
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
  budget: Budget,
): Promise<{ text: string; partial: boolean }> {
  const head = await resolveHead(root, budget);
  const tree = head ? await treeEntries(root, head, budget) : new Map();
  const index = await indexEntries(root, budget);
  const untracked = await untrackedPaths(root, budget);
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
    budget.check();
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
          reason: entryOmissionReason(indexed),
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
  const recent = head ? await recentCommits(root, budget) : "";
  const text = [
    `branch: ${(await branchName(root, budget)) || "(detached)"}`,
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
  budget.check();
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
  budget: Budget,
): Promise<Comparison> {
  const head = await resolveHead(root, budget);
  const tree = head ? await treeEntries(root, head, budget) : new Map();
  const index = await indexEntries(root, budget);
  const untracked = await untrackedPaths(root, budget);
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
    budget.check();
    if (index.unmerged.includes(path)) continue;
    const before = tree.get(path);
    const indexed = index.entries.get(path);
    if (isImagePath(path)) {
      comparison.omitted.push({ path, reason: "image content omitted" });
      continue;
    }
    const unsupported = [before, indexed].find(
      (entry) => entry && entry.type !== "blob",
    );
    if (unsupported) {
      comparison.omitted.push({
        path,
        reason: entryOmissionReason(unsupported),
      });
      continue;
    }
    const after =
      spec === "staged"
        ? indexed
        : indexed
          ? await worktreeFile(root, path, budget)
          : undefined;
    if (before?.oid === after?.oid && before?.mode === after?.mode) continue;
    const beforeContent = before
      ? await blobContent(root, before.oid, budget)
      : undefined;
    const afterContent = after
      ? spec === "staged"
        ? await blobContent(root, indexed!.oid, budget)
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
  budget: Budget,
): Promise<Comparison> {
  const before = from ? await treeEntries(root, from, budget) : new Map();
  const after = await treeEntries(root, to, budget);
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
    budget.check();
    const previous = before.get(path),
      current = after.get(path);
    const unsupported = [previous, current].find(
      (entry) => entry && entry.type !== "blob",
    );
    if (unsupported) {
      comparison.omitted.push({
        path,
        reason: entryOmissionReason(unsupported),
      });
      continue;
    }
    if (
      previous?.oid === current?.oid &&
      previous?.mode === current?.mode &&
      !isImagePath(path)
    )
      continue;
    if (isImagePath(path)) {
      comparison.omitted.push({ path, reason: "image content omitted" });
      continue;
    }
    const previousContent = previous
      ? await blobContent(root, previous.oid, budget)
      : undefined;
    const currentContent = current
      ? await blobContent(root, current.oid, budget)
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

async function renderComparison(
  command: string,
  comparison: Comparison,
  budget: Budget,
  maxBytes: number,
): Promise<{ text: string; locator: string; partial: boolean }> {
  const sections: string[] = [];
  const limit = Math.min(maxBytes, outputLimit);
  let renderedBytes = 0;
  const appendSection = (section: string) => {
    budget.check();
    const bytes = Buffer.byteLength(section) + (sections.length ? 1 : 0);
    budget.check();
    if (renderedBytes + bytes > limit)
      throw new AgentError(
        "INPUT_SIZE",
        "Git input exceeds the configured input limit",
      );
    sections.push(section);
    renderedBytes += bytes;
    budget.check();
  };
  if (comparison.metadata) appendSection(comparison.metadata);
  for (const [index, change] of comparison.changes.entries()) {
    budget.check();
    const header =
      change.before && change.after && change.before.mode !== change.after.mode
        ? `mode ${change.before.mode} => ${change.after.mode} ${quote(change.path)}`
        : !change.before
          ? `new file mode ${change.after!.mode} ${quote(change.path)}`
          : !change.after
            ? `deleted file mode ${change.before.mode} ${quote(change.path)}`
            : `modified ${quote(change.path)}`;
    const timeout = Math.min(250, budget.remainingMs());
    const patch = createTwoFilesPatch(
      change.before ? "a/file" : "/dev/null",
      change.after ? "b/file" : "/dev/null",
      change.before?.content?.toString("utf8") ?? "",
      change.after?.content?.toString("utf8") ?? "",
      undefined,
      undefined,
      { context: 3, timeout, maxEditLength: 20_000 },
    );
    if (patch === undefined)
      throw new AgentError(
        "GIT_LIMIT",
        `Git diff exceeded its time or edit limit for ${quote(change.path)}`,
      );
    budget.check();
    appendSection(`${header}\n${patch}`);
    if (index + 1 < comparison.changes.length) {
      await yieldEventLoop();
      budget.check();
    }
  }
  budget.check();
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
    appendSection(
      comparison.omitted.length
        ? "[PARTIAL: every change in this selection was omitted from the text comparison.]"
        : "[No text changes in this selection.]",
    );
  for (const note of notes) appendSection(note);
  appendSection(gitComparisonNotice);
  budget.check();
  const partial =
    comparison.omitted.length > 0 || comparison.unmerged.length > 0;
  const text = sections.join("\n");
  budget.check();
  return {
    text,
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

function classifyEntry(mode: string, type: string): Entry["type"] {
  const expected =
    mode === "100644" || mode === "100755" || mode === "120000"
      ? "blob"
      : mode === "160000"
        ? "commit"
        : mode === "040000"
          ? "tree"
          : undefined;
  if (!expected || type !== expected)
    throw new AgentError(
      "GIT_INPUT",
      `Git entry has an unsupported mode/type combination: ${mode} ${type}`,
    );
  return mode === "120000" ? "link" : expected;
}

function classifyIndexMode(mode: string): Entry["type"] {
  if (mode === "100644" || mode === "100755") return "blob";
  if (mode === "120000") return "link";
  if (mode === "160000") return "commit";
  if (mode === "040000") return "tree";
  throw new AgentError("GIT_INPUT", `Git index mode is unsupported: ${mode}`);
}

function entryOmissionReason(entry: Entry): string {
  const kind =
    entry.type === "link"
      ? "symbolic link"
      : entry.type === "commit"
        ? "submodule"
        : entry.type === "tree"
          ? "tree"
          : `entry type ${entry.type}`;
  return `unsupported ${kind} entry (mode ${entry.mode})`;
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
    return new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(data);
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
      budget,
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
  budget: Budget,
): Promise<Map<string, Entry>> {
  const output = await gitBytes(
    root,
    ["ls-tree", "-r", "-z", "--full-tree", commit],
    budget,
    outputLimit,
  );
  const entries = new Map<string, Entry>();
  const records = nulRecords(output);
  budget.check();
  for (const record of records) {
    budget.check();
    const separator = record.indexOf(9);
    const header =
      separator >= 0 ? record.subarray(0, separator) : Buffer.alloc(0);
    const path =
      separator >= 0 ? decodePath(record.subarray(separator + 1)) : "";
    const headerText = decodeUtf8(header);
    const fields = headerText.split(" ");
    const [mode, type, oid] = fields;
    if (fields.length !== 3 || fields.some((field) => !field))
      throw new AgentError("GIT_INPUT", "Git tree entry header is malformed");
    if (!mode || !type || !oid || !path || !commitHash.test(oid))
      throw new AgentError("GIT_INPUT", "Git tree entry is malformed");
    validateGitPath(path);
    const classifiedType = classifyEntry(mode, type);
    if (entries.size >= maxTrackedPaths)
      throw new AgentError("GIT_LIMIT", "Git tree exceeds the path limit");
    if (entries.has(path))
      throw new AgentError("GIT_INPUT", "Git tree contains a duplicate path");
    entries.set(path, { mode, type: classifiedType, oid });
  }
  return entries;
}

async function indexEntries(
  root: string,
  budget: Budget,
): Promise<{ entries: Map<string, Entry>; unmerged: string[] }> {
  const output = await gitBytes(
    root,
    ["ls-files", "--stage", "-z", "--full-name"],
    budget,
    outputLimit,
  );
  const entries = new Map<string, Entry>(),
    unmerged = new Set<string>(),
    seenStages = new Map<string, Set<string>>();
  const records = nulRecords(output);
  budget.check();
  if (records.length > maxTrackedPaths)
    throw new AgentError("GIT_LIMIT", "Git index exceeds the path limit");
  for (const record of records) {
    budget.check();
    const separator = record.indexOf(9);
    const header =
      separator >= 0 ? decodeUtf8(record.subarray(0, separator)) : "";
    const path =
      separator >= 0 ? decodePath(record.subarray(separator + 1)) : "";
    const fields = header.split(" ");
    const [mode, oid, stage] = fields;
    if (fields.length !== 3 || fields.some((field) => !field))
      throw new AgentError("GIT_INPUT", "Git index entry header is malformed");
    if (!mode || !oid || !stage || !path || !commitHash.test(oid))
      throw new AgentError("GIT_INPUT", "Git index entry is malformed");
    validateGitPath(path);
    const type = classifyIndexMode(mode);
    if (!["0", "1", "2", "3"].includes(stage))
      throw new AgentError("GIT_INPUT", "Git index stage is unsupported");
    if (entries.size >= maxTrackedPaths)
      throw new AgentError("GIT_LIMIT", "Git index exceeds the path limit");
    let stages = seenStages.get(path);
    if (!stages) {
      stages = new Set();
      seenStages.set(path, stages);
    }
    if (stages.has(stage))
      throw new AgentError(
        "GIT_INPUT",
        "Git index contains a duplicate path/stage record",
      );
    if (stages.has("0") || (stage === "0" && stages.size > 0))
      throw new AgentError(
        "GIT_INPUT",
        "Git index contains incompatible stages for one path",
      );
    stages.add(stage);
    if (stage !== "0") {
      unmerged.add(path);
      entries.delete(path);
      continue;
    }
    entries.set(path, { mode, oid, type });
  }
  return { entries, unmerged: [...unmerged] };
}

async function untrackedPaths(root: string, budget: Budget): Promise<string[]> {
  const output = await gitBytes(
    root,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    budget,
    outputLimit,
  );
  const records = nulRecords(output),
    paths: string[] = [];
  for (const record of records) {
    budget.check();
    const path = decodePath(record);
    validateGitPath(path);
    paths.push(path);
  }
  if (paths.length > maxTrackedPaths)
    throw new AgentError("GIT_LIMIT", "Git untracked paths exceed the limit");
  return paths;
}

async function hashFormat(
  root: string,
  budget: Budget,
): Promise<"sha1" | "sha256"> {
  const format = (
    await gitText(root, ["rev-parse", "--show-object-format"], budget, 32)
  ).trim();
  if (format !== "sha1" && format !== "sha256")
    throw new AgentError(
      "GIT_INPUT",
      `Unsupported Git object format: ${format}`,
    );
  budget.objectFormat = format;
  return format;
}

async function branchName(
  root: string,
  budget: Budget,
): Promise<string | undefined> {
  const result = await gitTry(
    root,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    budget,
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

async function recentCommits(root: string, budget: Budget): Promise<string> {
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
    budget,
    outputLimit,
  ).then((text) => text.trimEnd());
}

async function commitMetadata(
  root: string,
  commit: string,
  budget: Budget,
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
    budget,
    100_000,
  );
  return output.trimEnd();
}

async function resolveHead(
  root: string,
  budget: Budget,
): Promise<string | undefined> {
  const rawHead = await gitTry(
    root,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD"],
    budget,
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
      budget,
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
    budget,
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
  budget: Budget,
): Promise<string> {
  if (!commitHash.test(revision))
    throw new AgentError("GIT_REF", "Git revisions must be full object hashes");
  const resolved = (
    await gitText(
      root,
      ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
      budget,
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
  budget: Budget,
): Promise<string | undefined> {
  const output = await gitText(
    root,
    ["log", "-1", "--no-patch", "--no-show-signature", "--format=%P", commit],
    budget,
    4096,
  );
  const parent = output.trim().split(/\s+/)[0];
  if (!parent) return undefined;
  if (!commitHash.test(parent))
    throw new AgentError("GIT_REF", "Parent did not resolve to a full commit");
  return resolveCommit(root, parent, budget);
}

async function repositoryRoot(
  workspace: string,
  budget: Budget,
): Promise<string> {
  const output = await gitText(
    workspace,
    ["rev-parse", "--show-toplevel"],
    budget,
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
    budget.check();
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
  budget: Budget,
  maxBytes: number,
): Promise<string> {
  const text = decodeUtf8(await gitBytes(root, args, budget, maxBytes));
  budget.check();
  return text;
}

async function gitBytes(
  root: string,
  args: string[],
  budget: Budget,
  maxBytes: number,
): Promise<Buffer> {
  const result = await gitTry(root, args, budget, maxBytes);
  budget.check();
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
  budget: Budget,
  maxBytes: number,
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    budget.check();
    const timeoutMs = budget.remainingMs();
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
      errorLength = 0,
      settled = false;
    const finish = (
      error?: Error,
      value?: { code: number; stdout: Buffer; stderr: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      budget.signal.removeEventListener("abort", abort);
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
    }, timeoutMs);
    budget.signal.addEventListener("abort", abort, { once: true });
    if (budget.signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
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
      if (settled || errorLength >= 4096) return;
      const part = chunk.subarray(0, 4096 - errorLength);
      errors.push(part);
      errorLength += part.length;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      try {
        budget.check();
        const stdout = Buffer.concat(output, length);
        const stderr = Buffer.concat(errors, errorLength).toString("utf8");
        budget.check();
        finish(undefined, { code: code ?? 1, stdout, stderr });
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Git input failed"));
      }
    });
  });
}
