import { chmod, mkdir, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Paths, Config } from "./config.js";
import type { Conversation } from "./conversations.js";
import {
  emptyConversationContext,
  normalizeConversationContext,
} from "./context.js";
import { loadPreparedInput } from "./documents.js";
import {
  loadStoredImage,
  maxConversationImageBytes,
  maxConversationImages,
} from "./images.js";
import { Store } from "./storage.js";
import {
  AgentError,
  type DataClass,
  type Artifact,
  type ConversationContext,
  type DocumentReference,
  type ImageReference,
  type Run,
} from "./types.js";
import {
  atomicWrite,
  canonical,
  id,
  privateDirectory,
  readBoundedFile,
  safePath,
  sha256,
} from "./util.js";
import {
  inventory,
  readSnapshot,
  secretPath,
  type FileEntry,
} from "./workspace.js";

export type ForkMode = "state" | "history";
export const forkObjective = "会話の分岐用に保存状態を復元（推論・検証なし）";

export interface ForkPoint {
  seq: number;
  role: string;
  at: number;
  excerpt: string;
  stateAvailable: boolean;
  unavailableReason?: string;
}
export interface ForkBinding {
  sessionId: string;
  seq: number;
  hash: string;
  generation: number;
}
export interface ForkPreview {
  sessionId: string;
  seq: number;
  mode: ForkMode;
  binding: string;
  messageCount: number;
  message: { role: string; excerpt: string };
  stateAvailable: boolean;
  warnings: string[];
  savedWorkspaceFiles: number;
  savedDocumentFiles: number;
}
interface SnapshotFile {
  path: string;
  hash: string;
  bytes: number;
  mode: number;
}
interface TreeSnapshot {
  origin?: string;
  head?: string;
  includeUntracked: boolean;
  extraPaths?: string[];
  baseline: SnapshotFile[];
  work: SnapshotFile[];
  redactedPaths: string[];
}
export interface BoundaryCaptureOptions {
  visibleRunIds?: string[];
}
export interface BoundaryState {
  version: 1;
  settings: Pick<
    Conversation,
    | "name"
    | "model"
    | "reviewer"
    | "strategy"
    | "kind"
    | "dataClass"
    | "localOnly"
    | "includeUntracked"
    | "checks"
    | "access"
  >;
  context: ConversationContext;
  images: ImageReference[];
  preparedInputs: DocumentReference[];
  artifacts: Array<{
    artifact: Artifact;
    producer: Pick<Run, "id" | "state" | "parentRunId">;
    saveSeq: number;
  }>;
  coding?: TreeSnapshot;
  document?: TreeSnapshot;
  codingRunId?: string;
  documentRunId?: string;
  policy: {
    dataClass: DataClass;
    localOnly: boolean;
    excluded: ConversationContext;
  };
  unavailableReason?: string;
}
export interface BoundaryRecord {
  id: string;
  sessionId: string;
  messageSeq: number;
  hash: string;
  payload: BoundaryState;
  stateAvailable: boolean;
}

const maxExcerpt = 300;
const maxMessages = 10_000;
const maxPrefixBytes = 32 * 1024 * 1024;
const maxMetadataBytes = 4 * 1024 * 1024;
const maxArtifactReferences = 2_000;
const maxFiles = 10_000;

function excerpt(text: string): string {
  return [...text].slice(0, maxExcerpt).join("");
}
function boundaryState(raw: string): BoundaryState {
  try {
    const state = JSON.parse(raw) as BoundaryState;
    if (state.version !== 1 || !state.settings || !state.context)
      throw new Error("boundary");
    return state;
  } catch {
    throw new AgentError("FORK_CORRUPT", "Saved boundary is malformed");
  }
}
async function tree(
  paths: Paths,
  run: Run,
  config: Config,
  deadline: number,
): Promise<TreeSnapshot> {
  const directory = join(paths.runs, run.id);
  const snapshot = JSON.parse(
    (
      await readBoundedFile(
        join(directory, "snapshot.json"),
        maxMetadataBytes,
        { privateStorage: true },
      )
    ).toString("utf8"),
  ) as Awaited<ReturnType<typeof readSnapshot>>;
  const result: TreeSnapshot = {
    origin: snapshot.origin,
    head: snapshot.head,
    includeUntracked: snapshot.includeUntracked,
    extraPaths: snapshot.extraPaths,
    baseline: [],
    work: [],
    redactedPaths: snapshot.redactedPaths ?? [],
  };
  await privateDirectory(paths.checkpoints);
  await privateDirectory(join(paths.checkpoints, "blobs"));
  const capture = async (root: string, listed?: Record<string, FileEntry>) => {
    const total = { value: 0 };
    const files =
      listed ?? (await inventory(root, config.limits.maxWorkspaceBytes));
    if (Object.keys(files).length > maxFiles)
      throw new AgentError("FORK_SIZE", "Saved workspace has too many files");
    const output: SnapshotFile[] = [];
    for (const [path, entry] of Object.entries(files).sort()) {
      if (Date.now() > deadline)
        throw new AgentError("FORK_TIMEOUT", "Checkpoint capture timed out");
      if (secretPath(path))
        throw new AgentError(
          "FORK_CONTENT",
          "Protected workspace path in snapshot",
        );
      const target = await safePath(root, path);
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new AgentError("FORK_CONTENT", "Unsafe saved workspace file");
      total.value += entry.bytes;
      if (total.value > config.limits.maxWorkspaceBytes)
        throw new AgentError("FORK_SIZE", "Saved workspace exceeds its limit");
      const content = await readBoundedFile(target, entry.bytes, {
        expectedBytes: entry.bytes,
        expectedSha256: entry.hash,
      });
      const blob = join(paths.checkpoints, "blobs", entry.hash);
      try {
        const existing = await readBoundedFile(blob, entry.bytes, {
          expectedBytes: entry.bytes,
          expectedSha256: entry.hash,
          privateStorage: true,
        });
        if (!existing.equals(content)) throw new Error("blob");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await atomicWrite(blob, content);
      }
      output.push({ path, ...entry });
    }
    return output;
  };
  result.baseline = await capture(join(directory, "baseline"), snapshot.files);
  result.work = await capture(join(directory, "work"));
  return result;
}
async function restoreTree(
  paths: Paths,
  target: string,
  tree: TreeSnapshot,
): Promise<void> {
  const validate = (entry: SnapshotFile) => {
    if (
      !entry.path ||
      entry.path.startsWith("/") ||
      entry.path.includes("\0") ||
      entry.path.split("/").some((part) => part === ".." || part === ".") ||
      secretPath(entry.path) ||
      !/^[a-f0-9]{64}$/.test(entry.hash) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      entry.bytes > 32 * 1024 * 1024 ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777
    )
      throw new AgentError("FORK_CORRUPT", "Saved workspace entry is invalid");
  };
  if (
    tree.baseline.length > 10_000 ||
    tree.work.length > 10_000 ||
    tree.baseline.length + tree.work.length > 20_000
  )
    throw new AgentError("FORK_SIZE", "Saved workspace has too many files");
  await mkdir(join(target, "baseline"), { recursive: true, mode: 0o700 });
  await mkdir(join(target, "work"), { recursive: true, mode: 0o700 });
  for (const [name, files] of [
    ["baseline", tree.baseline],
    ["work", tree.work],
  ] as const)
    for (const entry of files) {
      validate(entry);
      const content = await readBoundedFile(
        join(paths.checkpoints, "blobs", entry.hash),
        entry.bytes,
        {
          expectedBytes: entry.bytes,
          expectedSha256: entry.hash,
          privateStorage: true,
        },
      );
      await mkdir(dirname(join(target, name, entry.path)), {
        recursive: true,
        mode: 0o700,
      });
      await atomicWrite(join(target, name, entry.path), content);
      await chmod(join(target, name, entry.path), entry.mode);
    }
  await atomicWrite(
    join(target, "snapshot.json"),
    JSON.stringify({
      origin: tree.origin,
      head: tree.head,
      includeUntracked: tree.includeUntracked,
      extraPaths: tree.extraPaths,
      files: Object.fromEntries(
        tree.baseline.map((entry) => [
          entry.path,
          {
            hash: entry.hash,
            bytes: entry.bytes,
            mode: entry.mode,
          },
        ]),
      ),
      redactedPaths: tree.redactedPaths,
    }),
  );
}

export async function captureBoundary(
  paths: Paths,
  config: Config,
  store: Store,
  session: Conversation,
  messageSeq: number,
  unavailableReason?: string,
  options: BoundaryCaptureOptions = {},
): Promise<BoundaryRecord> {
  const context = normalizeConversationContext(session.context);
  const state: BoundaryState = {
    version: 1,
    settings: {
      name: session.name,
      model: session.model,
      reviewer: session.reviewer,
      strategy: session.strategy,
      kind: session.kind,
      dataClass: session.dataClass,
      localOnly: session.localOnly,
      includeUntracked: session.includeUntracked,
      checks: [...session.checks],
      access: session.access,
    },
    context: { ...context, instructions: [], compactions: [] },
    images: [],
    preparedInputs: [],
    artifacts: [],
    policy: {
      dataClass: session.dataClass,
      localOnly: session.localOnly,
      excluded: structuredClone(context),
    },
    ...(unavailableReason ? { unavailableReason } : {}),
  };
  if (!unavailableReason) {
    const visibleRunIds = [
      ...(options.visibleRunIds ?? []),
      session.workRunId,
      session.documentRunId,
    ].filter((value): value is string => !!value);
    const runIds = [...new Set(visibleRunIds)];
    const linkedRunIds = [
      ...new Set([
        ...store.db
          .prepare("SELECT run_id FROM conversation_runs WHERE session_id=?")
          .all(session.id)
          .map((row) => (row as { run_id: string }).run_id),
        ...runIds,
      ]),
    ];
    const runs = [...new Set(linkedRunIds)].map((runId) => store.get(runId));
    const deadline = Date.now() + 30_000;
    for (const run of runs) {
      store.assertIdle(run.id);
      if (
        store
          .operations(run.id)
          .some((operation) =>
            ["prepared", "dispatched", "unknown"].includes(operation.status),
          )
      )
        throw new AgentError(
          "UNKNOWN_OPERATION",
          "Boundary capture requires an idle, reconciled run",
        );
    }
    let artifactBytes = 0;
    const capturedArtifactIds = new Set<string>();
    for (const run of runs) {
      const levels: DataClass[] = ["public", "private", "restricted"];
      if (
        levels.indexOf(run.dataClass) > levels.indexOf(state.policy.dataClass)
      )
        state.policy.dataClass = run.dataClass;
      state.policy.localOnly ||= run.localOnly;
      if (runIds.includes(run.id))
        state.images.push(...structuredClone(run.images ?? []));
      for (const image of run.images ?? []) {
        if (
          levels.indexOf(image.dataClass) >
          levels.indexOf(state.policy.dataClass)
        )
          state.policy.dataClass = image.dataClass;
        state.policy.localOnly ||= image.localOnly;
      }
      if (runIds.includes(run.id) && run.preparedInputs)
        state.preparedInputs.push(...structuredClone(run.preparedInputs));
      for (const artifact of store.artifacts(run.id)) {
        if (capturedArtifactIds.has(artifact.id)) continue;
        capturedArtifactIds.add(artifact.id);
        if (state.artifacts.length >= maxArtifactReferences)
          throw new AgentError("FORK_SIZE", "Too many captured artifacts");
        artifactBytes += artifact.bytes;
        if (artifactBytes > config.limits.maxWorkspaceBytes + maxPrefixBytes)
          throw new AgentError(
            "FORK_SIZE",
            "Captured artifacts exceed their limit",
          );
        await readBoundedFile(
          join(paths.runs, artifact.runId, "artifacts", artifact.sha256),
          config.limits.maxWorkspaceBytes + maxPrefixBytes,
          {
            expectedBytes: artifact.bytes,
            expectedSha256: artifact.sha256,
            privateStorage: true,
          },
        );
        const producer = store.get(artifact.runId);
        const saved = store.db
          .prepare(
            "SELECT seq FROM events WHERE run_id=? AND type='artifact_saved' AND json_extract(detail,'$.artifactId')=? ORDER BY seq LIMIT 1",
          )
          .get(artifact.runId, artifact.id) as { seq: number } | undefined;
        state.artifacts.push({
          artifact: structuredClone(artifact),
          producer: {
            id: producer.id,
            state: producer.state,
            parentRunId: producer.parentRunId,
          },
          saveSeq: saved?.seq ?? 0,
        });
        if (
          levels.indexOf(artifact.dataClass) >
          levels.indexOf(state.policy.dataClass)
        )
          state.policy.dataClass = artifact.dataClass;
      }
      if (runIds.includes(run.id) && run.kind === "coding") {
        state.coding = await tree(paths, run, config, deadline);
        if (state.coding.origin && state.coding.origin !== session.workspace)
          throw new AgentError("FORK_SCOPE", "Coding snapshot origin changed");
        state.codingRunId = run.id;
      }
      if (
        runIds.includes(run.id) &&
        (run.kind === "writing" || run.kind === "research")
      ) {
        state.document = await tree(paths, run, config, deadline);
        state.documentRunId = run.id;
      }
    }
    state.images = [
      ...new Map(state.images.map((image) => [image.id, image])).values(),
    ];
    state.preparedInputs = [
      ...new Map(
        state.preparedInputs.map((input) => [input.id, input]),
      ).values(),
    ];
    for (const reference of state.preparedInputs)
      await loadPreparedInput(paths, reference);
    if (
      state.images.length > maxConversationImages ||
      state.images.reduce((sum, image) => sum + image.bytes, 0) >
        maxConversationImageBytes
    )
      throw new AgentError("FORK_SIZE", "Captured images exceed their limit");
    for (const image of state.images) await loadStoredImage(paths, image);
  }
  const serialized = canonical(state);
  if (Buffer.byteLength(serialized) > maxMetadataBytes)
    throw new AgentError(
      "FORK_SIZE",
      "Saved boundary metadata exceeds its limit",
    );
  const record: BoundaryRecord = {
    id: id(),
    sessionId: session.id,
    messageSeq,
    hash: sha256(serialized),
    payload: state,
    stateAvailable: !unavailableReason,
  };
  return record;
}

export function persistBoundary(
  store: Store,
  record: BoundaryRecord,
  messageSeq: number,
): void {
  const payload = canonical(record.payload);
  record.messageSeq = messageSeq;
  store.saveBoundary({
    id: record.id,
    sessionId: record.sessionId,
    messageSeq,
    hash: record.hash,
    payload,
    stateAvailable: record.stateAvailable,
    artifactIds: [
      ...new Set(record.payload.artifacts.map(({ artifact }) => artifact.id)),
    ],
  });
}

export function saveUnavailableBoundary(
  store: Store,
  session: Conversation,
  messageSeq: number,
  reason: string,
  persist = true,
): BoundaryRecord {
  const payload: BoundaryState = {
    version: 1,
    settings: {
      name: session.name,
      model: session.model,
      reviewer: session.reviewer,
      strategy: session.strategy,
      kind: session.kind,
      dataClass: session.dataClass,
      localOnly: session.localOnly,
      includeUntracked: session.includeUntracked,
      checks: [...session.checks],
      access: session.access,
    },
    context: emptyConversationContext(),
    images: [],
    preparedInputs: [],
    artifacts: [],
    policy: {
      dataClass: session.dataClass,
      localOnly: session.localOnly,
      excluded: normalizeConversationContext(session.context),
    },
    unavailableReason: reason.slice(0, 500),
  };
  const serialized = canonical(payload);
  const record = {
    id: id(),
    sessionId: session.id,
    messageSeq,
    hash: sha256(serialized),
    payload,
    stateAvailable: false,
  };
  if (persist)
    store.saveBoundary({
      id: record.id,
      sessionId: session.id,
      messageSeq,
      hash: record.hash,
      payload: serialized,
      stateAvailable: false,
      artifactIds: [],
    });
  return record;
}

export function pointFromMessage(
  message: { seq: number; role: string; text: string; at: number },
  boundary?: { state_available: number; payload: string },
): ForkPoint {
  let stateAvailable = !!boundary?.state_available;
  let unavailableReason: string | undefined;
  if (boundary) {
    const state = boundaryState(boundary.payload);
    unavailableReason = state.unavailableReason;
  } else {
    unavailableReason =
      "このメッセージには保存状態がありません。履歴のみ分岐できます。";
  }
  return {
    seq: message.seq,
    role: message.role,
    at: message.at,
    excerpt: excerpt(message.text),
    stateAvailable,
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

export function stateForBoundary(row: {
  payload: string;
  hash?: string;
}): BoundaryState {
  const state = boundaryState(row.payload);
  if (row.hash && sha256(canonical(state)) !== row.hash)
    throw new AgentError("FORK_CORRUPT", "Saved boundary hash does not match");
  return state;
}
export async function restoreBoundaryTree(
  paths: Paths,
  runDir: string,
  treeSnapshot: TreeSnapshot,
): Promise<void> {
  await restoreTree(paths, runDir, treeSnapshot);
}
export function forkHash(
  sessionId: string,
  seq: number,
  mode: ForkMode,
  boundaryHash: string,
  generation: number,
  workspace = "",
  config = "",
  policy = "",
): string {
  return sha256(
    canonical({
      sessionId,
      seq,
      mode,
      boundaryHash,
      generation,
      workspace,
      config,
      policy,
    }),
  );
}
export function countTreeFiles(treeSnapshot: TreeSnapshot | undefined): number {
  return treeSnapshot?.work.length ?? 0;
}
export function messagePrefixBytes(messages: Array<{ text: string }>): number {
  if (messages.length > maxMessages)
    throw new AgentError("FORK_SIZE", "Message prefix exceeds its limit");
  const bytes = messages.reduce(
    (sum, message) => sum + Buffer.byteLength(message.text),
    0,
  );
  if (bytes > maxPrefixBytes)
    throw new AgentError("FORK_SIZE", "Message prefix exceeds its limit");
  return bytes;
}

export function assertPrefixBounds(count: number, bytes: number): void {
  if (count > maxMessages || bytes > maxPrefixBytes)
    throw new AgentError("FORK_SIZE", "Message prefix exceeds its limit");
}
