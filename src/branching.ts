import { chmod, mkdir, lstat, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
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
  decodeBoundary,
  validateBoundaryTree,
  maxBoundaryBytes,
  maxBoundaryFiles,
} from "./branch-validation.js";
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
import { pinSharedBlobs } from "./shared-blobs.js";
import {
  inventory,
  readSnapshot,
  secretPath,
  snapshotWorkspace,
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
  applied?: boolean;
}
export interface BoundaryState {
  version: 1;
  prefixDigest?: string;
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
  evidenceImages?: ImageReference[];
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

export function safetyContext(
  ...values: Array<ConversationContext | undefined>
): ConversationContext {
  const context = emptyConversationContext();
  for (const field of [
    "excludedSourceIds",
    "excludedSourceHashes",
    "excludedSourceUrls",
    "redactedImageIds",
  ] as const)
    context[field] = [
      ...new Set(values.flatMap((value) => value?.[field] ?? [])),
    ];
  return context;
}

export function lineagePolicy(
  store: Store,
  sessionId: string,
): BoundaryState["policy"] | undefined {
  const lineage = store.lineage(sessionId);
  if (!lineage) return undefined;
  try {
    if (Buffer.byteLength(lineage.policy_floor) > maxBoundaryBytes)
      throw new Error("size");
    const value = JSON.parse(lineage.policy_floor) as BoundaryState["policy"];
    if (
      !["public", "private", "restricted"].includes(value.dataClass) ||
      typeof value.localOnly !== "boolean"
    )
      throw new Error("policy");
    for (const field of [
      "excludedSourceIds",
      "excludedSourceHashes",
      "excludedSourceUrls",
      "redactedImageIds",
    ] as const)
      if (
        value.excluded?.[field] !== undefined &&
        (!Array.isArray(value.excluded[field]) ||
          !value.excluded[field]!.every((item) => typeof item === "string"))
      )
        throw new Error("exclusions");
    return { ...value, excluded: safetyContext(value.excluded) };
  } catch {
    throw new AgentError("FORK_CORRUPT", "Branch disclosure policy is invalid");
  }
}

export function forkPolicy(
  store: Store,
  session: Conversation,
  state?: BoundaryState,
): BoundaryState["policy"] {
  const inherited = lineagePolicy(store, session.id);
  const policy = {
    dataClass: session.dataClass,
    localOnly: session.localOnly,
    excluded: safetyContext(
      session.context,
      inherited?.excluded,
      state?.policy.excluded,
    ),
  };
  const levels: DataClass[] = ["public", "private", "restricted"];
  const historical = store.db
    .prepare(
      "SELECT DISTINCT json_extract(r.payload,'$.dataClass') AS dataClass,json_extract(r.payload,'$.localOnly') AS localOnly FROM runs r JOIN conversation_runs cr ON cr.run_id=r.id WHERE cr.session_id=?",
    )
    .all(session.id) as Array<{ dataClass: DataClass; localOnly: number }>;
  for (const floor of [inherited, state?.policy, ...historical]) {
    if (!floor) continue;
    if (!levels.includes(floor.dataClass))
      throw new AgentError(
        "FORK_CORRUPT",
        "Historical disclosure policy is invalid",
      );
    if (levels.indexOf(floor.dataClass) > levels.indexOf(policy.dataClass))
      policy.dataClass = floor.dataClass;
    policy.localOnly ||= !!floor.localOnly;
  }
  if (Buffer.byteLength(canonical(policy)) > maxBoundaryBytes)
    throw new AgentError("FORK_SIZE", "Branch policy exceeds its limit");
  return policy;
}

export function checkpointArtifacts(
  store: Store,
  sessionId: string,
): Map<string, BoundaryState["artifacts"][number]> {
  const checkpointId = store.lineage(sessionId)?.checkpoint_id;
  if (!checkpointId) return new Map();
  const row = store.boundaryById(checkpointId);
  if (!row)
    throw new AgentError("FORK_CORRUPT", "Branch checkpoint is unavailable");
  return new Map(
    stateForBoundary(row).artifacts.map((item) => [item.artifact.id, item]),
  );
}

function checkDeadline(deadline: number): void {
  if (Date.now() > deadline)
    throw new AgentError("FORK_TIMEOUT", "Checkpoint operation timed out");
}

async function checkPrivateDirectory(
  root: string,
  relative?: string,
): Promise<void> {
  const path = relative ? await safePath(root, relative) : root;
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new AgentError(
      "UNSAFE_STORAGE",
      "Checkpoint directory must be private and owned",
    );
}

async function checkCheckpointDirectories(paths: Paths): Promise<void> {
  await checkPrivateDirectory(paths.home);
  await checkPrivateDirectory(paths.home, "checkpoints");
  await checkPrivateDirectory(paths.home, "checkpoints/blobs");
}

export function prefixDigest(
  store: Store,
  sessionId: string,
  seq: number,
): string {
  const stats = store.db
    .prepare(
      "SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(text AS BLOB))),0) AS bytes FROM messages WHERE session_id=? AND seq<=?",
    )
    .get(sessionId, seq) as { count: number; bytes: number };
  assertPrefixBounds(stats.count, stats.bytes);
  const rows = store.db
    .prepare(
      "SELECT role,text,at FROM messages WHERE session_id=? AND seq<=? ORDER BY seq",
    )
    .all(sessionId, seq);
  return sha256(canonical(rows));
}

export async function verifyBoundaryState(
  paths: Paths,
  config: Config,
  state: BoundaryState,
  workspace: string,
  deadline = Date.now() + 30_000,
): Promise<void> {
  if (!state.prefixDigest)
    throw new AgentError(
      "FORK_STATE",
      "この保存状態は旧形式です。会話本文のみの分岐を選択してください。",
    );
  await checkPrivateDirectory(paths.home);
  const seen = new Map<string, number>();
  for (const [kind, snapshot] of [
    ["coding", state.coding],
    ["document", state.document],
  ] as const) {
    if (!snapshot) continue;
    validateBoundaryTree(snapshot, config.limits.maxWorkspaceBytes);
    if (
      kind === "coding"
        ? snapshot.origin !== workspace
        : snapshot.origin !== undefined
    )
      throw new AgentError(
        "FORK_SCOPE",
        "Saved workspace origin is not authorized",
      );
    await checkCheckpointDirectories(paths);
    for (const entry of [...snapshot.baseline, ...snapshot.work]) {
      checkDeadline(deadline);
      if (seen.has(entry.hash)) {
        if (seen.get(entry.hash) !== entry.bytes)
          throw new AgentError("FORK_CORRUPT", "Blob sizes disagree");
        continue;
      }
      await pinSharedBlobs(paths, [`checkpoints/blobs/${entry.hash}`]);
      await readBoundedFile(
        await safePath(paths.checkpoints, `blobs/${entry.hash}`),
        config.limits.maxWorkspaceBytes,
        {
          expectedBytes: entry.bytes,
          expectedSha256: entry.hash,
          privateStorage: true,
        },
      );
      seen.set(entry.hash, entry.bytes);
    }
  }
  let bytes = 0;
  for (const { artifact } of state.artifacts) {
    checkDeadline(deadline);
    bytes += artifact.bytes;
    if (bytes > config.limits.maxWorkspaceBytes + maxPrefixBytes)
      throw new AgentError(
        "FORK_SIZE",
        "Captured artifacts exceed their limit",
      );
    const path = await safePath(
      paths.home,
      `runs/${artifact.runId}/artifacts/${artifact.sha256}`,
    );
    await readBoundedFile(
      path,
      config.limits.maxWorkspaceBytes + maxPrefixBytes,
      {
        expectedBytes: artifact.bytes,
        expectedSha256: artifact.sha256,
        privateStorage: true,
      },
    );
  }
  if (state.preparedInputs.length)
    await checkPrivateDirectory(paths.home, "attachments");
  if (
    state.images.reduce((sum, image) => sum + image.bytes, 0) >
    maxConversationImageBytes
  )
    throw new AgentError("FORK_SIZE", "Captured images exceed their limit");
  for (const image of state.images) {
    checkDeadline(deadline);
    await loadStoredImage(paths, image);
  }
  for (const input of state.preparedInputs) {
    checkDeadline(deadline);
    bytes += input.rawBytes + input.selectedBytes;
    if (bytes > config.limits.maxWorkspaceBytes + maxPrefixBytes)
      throw new AgentError("FORK_SIZE", "Captured inputs exceed their limit");
    await loadPreparedInput(paths, input);
  }
  checkDeadline(deadline);
}

const maxExcerpt = 300;
const maxMessages = 10_000;
const maxPrefixBytes = 32 * 1024 * 1024;
const maxMetadataBytes = maxBoundaryBytes;
const maxArtifactReferences = 2_000;
const maxFiles = maxBoundaryFiles;

function excerpt(text: string): string {
  return [...text].slice(0, maxExcerpt).join("");
}
function boundaryState(raw: string): BoundaryState {
  return decodeBoundary(raw);
}
async function tree(
  paths: Paths,
  run: Run,
  config: Config,
  deadline: number,
  sourceDirectory?: string,
): Promise<TreeSnapshot> {
  const directory = sourceDirectory ?? join(paths.runs, run.id);
  await checkPrivateDirectory(paths.home);
  await safePath(paths.home, relative(paths.home, directory));
  const snapshot = JSON.parse(
    (
      await readBoundedFile(
        join(directory, "snapshot.json"),
        maxMetadataBytes,
        { privateStorage: true },
      )
    ).toString("utf8"),
  ) as Awaited<ReturnType<typeof readSnapshot>>;
  if (
    !snapshot.files ||
    typeof snapshot.files !== "object" ||
    Array.isArray(snapshot.files)
  )
    throw new AgentError("FORK_CORRUPT", "Snapshot manifest is invalid");
  const result: TreeSnapshot = {
    origin: snapshot.origin,
    head: snapshot.head,
    includeUntracked: snapshot.includeUntracked,
    extraPaths: snapshot.extraPaths,
    baseline: [],
    work: [],
    redactedPaths: snapshot.redactedPaths ?? [],
  };
  validateBoundaryTree(
    {
      ...result,
      baseline: Object.entries(snapshot.files).map(([path, entry]) => ({
        path,
        ...entry,
      })),
    },
    config.limits.maxWorkspaceBytes,
  );
  await privateDirectory(paths.checkpoints);
  await privateDirectory(join(paths.checkpoints, "blobs"));
  await checkCheckpointDirectories(paths);
  const capture = async (root: string, listed?: Record<string, FileEntry>) => {
    const total = { value: 0 };
    const files =
      listed ??
      (await inventory(root, config.limits.maxWorkspaceBytes, {
        maxFiles,
        deadline,
      }));
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
      if ((info.mode & 0o777) !== entry.mode || info.size !== entry.bytes)
        throw new AgentError("FORK_STALE", "Saved workspace metadata changed");
      total.value += entry.bytes;
      if (total.value > config.limits.maxWorkspaceBytes)
        throw new AgentError("FORK_SIZE", "Saved workspace exceeds its limit");
      const content = await readBoundedFile(target, entry.bytes, {
        expectedBytes: entry.bytes,
        expectedSha256: entry.hash,
      });
      const blob = join(paths.checkpoints, "blobs", entry.hash);
      await pinSharedBlobs(paths, [`checkpoints/blobs/${entry.hash}`]);
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
  validateBoundaryTree(result, config.limits.maxWorkspaceBytes);
  const current = await inventory(
    join(directory, "work"),
    config.limits.maxWorkspaceBytes,
    { maxFiles, deadline },
  );
  if (
    canonical(current) !==
    canonical(
      Object.fromEntries(
        result.work.map(({ path, ...entry }) => [path, entry]),
      ),
    )
  )
    throw new AgentError(
      "FORK_STALE",
      "Workspace changed during checkpoint capture",
    );
  return result;
}
async function restoreTree(
  paths: Paths,
  target: string,
  snapshot: TreeSnapshot,
  config: Config,
  deadline: number,
): Promise<void> {
  const tree = validateBoundaryTree(snapshot, config.limits.maxWorkspaceBytes);
  await checkCheckpointDirectories(paths);
  await safePath(paths.home, relative(paths.home, target), true);
  await privateDirectory(target);
  await mkdir(join(target, "baseline"), { recursive: true, mode: 0o700 });
  await mkdir(join(target, "work"), { recursive: true, mode: 0o700 });
  for (const [name, files] of [
    ["baseline", tree.baseline],
    ["work", tree.work],
  ] as const)
    for (const entry of files) {
      checkDeadline(deadline);
      await pinSharedBlobs(paths, [`checkpoints/blobs/${entry.hash}`]);
      const content = await readBoundedFile(
        await safePath(paths.checkpoints, `blobs/${entry.hash}`),
        entry.bytes,
        {
          expectedBytes: entry.bytes,
          expectedSha256: entry.hash,
          privateStorage: true,
        },
      );
      const destination = await safePath(join(target, name), entry.path, true);
      await mkdir(dirname(destination), {
        recursive: true,
        mode: 0o700,
      });
      await atomicWrite(destination, content);
      await chmod(destination, entry.mode);
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
  const context = structuredClone(
    normalizeConversationContext(session.context),
  );
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
    policy: forkPolicy(store, session),
    ...(unavailableReason ? { unavailableReason } : {}),
  };
  if (!unavailableReason) {
    const visibleRunIds = options.visibleRunIds ?? [];
    const runIds = [
      ...new Set(
        [
          ...visibleRunIds,
          session.workRunId,
          session.documentRunId,
          ...(options.applied ? [session.appliedRunId] : []),
        ].filter((value): value is string => !!value),
      ),
    ];
    const size = store.db
      .prepare(
        "SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(r.payload AS BLOB))),0) AS bytes FROM runs r JOIN conversation_runs cr ON cr.run_id=r.id WHERE cr.session_id=?",
      )
      .get(session.id) as { count: number; bytes: number };
    assertPrefixBounds(size.count, size.bytes);
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
    const frozen = checkpointArtifacts(store, session.id);
    const visible = visibleRunIds.map((runId) => store.get(runId));
    const coding =
      visible.findLast((run) => !!run.workspace) ??
      runs.find((run) => run.id === session.workRunId);
    const document =
      visible.findLast(
        (run) =>
          !run.workspace &&
          run.access === "change" &&
          ["writing", "research"].includes(run.kind),
      ) ?? runs.find((run) => run.id === session.documentRunId);
    state.images = visible.length
      ? structuredClone(visible.at(-1)!.images ?? [])
      : [];
    const inheritedCheckpoint = store.lineage(session.id)?.checkpoint_id;
    const inheritedBoundary = inheritedCheckpoint
      ? store.boundaryById(inheritedCheckpoint)
      : undefined;
    state.evidenceImages = inheritedBoundary
      ? structuredClone(
          stateForBoundary(inheritedBoundary).evidenceImages ?? [],
        )
      : [];
    for (const run of runs) {
      checkDeadline(deadline);
      store.assertIdle(run.id);
      if (
        store.db
          .prepare(
            "SELECT 1 FROM operations WHERE run_id=? AND status IN ('prepared','dispatched','unknown') LIMIT 1",
          )
          .get(run.id)
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
      state.evidenceImages.push(...structuredClone(run.images ?? []));
      for (const image of run.images ?? []) {
        if (
          levels.indexOf(image.dataClass) >
          levels.indexOf(state.policy.dataClass)
        )
          state.policy.dataClass = image.dataClass;
        state.policy.localOnly ||= image.localOnly;
      }
      if (run.preparedInputs)
        state.preparedInputs.push(...structuredClone(run.preparedInputs));
      const artifactSize = store.db
        .prepare(
          "SELECT COUNT(*) AS count,COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM artifacts WHERE run_id=? OR id IN (SELECT artifact_id FROM source_links WHERE run_id=?)",
        )
        .get(run.id, run.id) as { count: number; bytes: number };
      if (
        artifactSize.count > maxArtifactReferences ||
        artifactSize.bytes > maxMetadataBytes
      )
        throw new AgentError(
          "FORK_SIZE",
          "Artifact metadata exceeds its limit",
        );
      for (const artifact of store.artifacts(run.id)) {
        checkDeadline(deadline);
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
        const prior = frozen.get(artifact.id);
        if (prior && canonical(prior.artifact) !== canonical(artifact))
          throw new AgentError(
            "FORK_CORRUPT",
            "Captured artifact metadata changed",
          );
        const producer = prior?.producer ?? store.get(artifact.runId);
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
          saveSeq: prior?.saveSeq ?? saved?.seq ?? 0,
        });
        if (
          levels.indexOf(artifact.dataClass) >
          levels.indexOf(state.policy.dataClass)
        )
          state.policy.dataClass = artifact.dataClass;
      }
    }
    if (coding) {
      state.coding = await tree(paths, coding, config, deadline);
      if (state.coding.origin !== session.workspace)
        throw new AgentError("FORK_SCOPE", "Coding snapshot origin changed");
      state.codingRunId = coding.id;
    } else if (session.appliedBoundaryId && !options.applied) {
      const previous = store.boundaryById(session.appliedBoundaryId);
      if (!previous || !previous.state_available)
        throw new AgentError(
          "FORK_STATE",
          "Applied baseline checkpoint is unavailable",
        );
      state.coding = structuredClone(stateForBoundary(previous).coding);
    }
    if (document) {
      state.document = await tree(paths, document, config, deadline);
      if (state.document.origin !== undefined)
        throw new AgentError(
          "FORK_SCOPE",
          "Document snapshot has a repository origin",
        );
      state.documentRunId = document.id;
    }
    if (options.applied && session.appliedRunId) {
      const applied = store.get(session.appliedRunId);
      const manifest = JSON.parse(
        (
          await readBoundedFile(
            join(paths.runs, applied.id, "validated-manifest.json"),
            maxMetadataBytes,
            { privateStorage: true },
          )
        ).toString("utf8"),
      ) as Record<string, unknown>;
      const extraPaths = Object.keys(manifest);
      if (extraPaths.length > maxFiles)
        throw new AgentError(
          "FORK_SIZE",
          "Applied workspace has too many files",
        );
      const temporary = await mkdtemp(join(paths.home, "checkpoint-"));
      try {
        await snapshotWorkspace(
          temporary,
          session.workspace,
          session.includeUntracked,
          config,
          extraPaths,
        );
        state.coding = await tree(paths, applied, config, deadline, temporary);
        state.codingRunId = applied.id;
      } finally {
        await rm(temporary, { recursive: true, force: true });
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
    state.evidenceImages = [
      ...new Map(
        state.evidenceImages.map((image) => [image.id, image]),
      ).values(),
    ];
    let inputBytes = 0;
    for (const reference of state.preparedInputs) {
      checkDeadline(deadline);
      inputBytes += reference.rawBytes + reference.selectedBytes;
      if (
        inputBytes + artifactBytes >
        config.limits.maxWorkspaceBytes + maxPrefixBytes
      )
        throw new AgentError("FORK_SIZE", "Captured inputs exceed their limit");
      await loadPreparedInput(paths, reference);
    }
    if (
      state.images.length > maxConversationImages ||
      state.images.reduce((sum, image) => sum + image.bytes, 0) >
        maxConversationImageBytes
    )
      throw new AgentError("FORK_SIZE", "Captured images exceed their limit");
    for (const image of state.images) await loadStoredImage(paths, image);
    for (const run of runs) {
      store.assertIdle(run.id);
      if (canonical(run) !== canonical(store.get(run.id)))
        throw new AgentError(
          "FORK_STALE",
          "Run changed during checkpoint capture",
        );
    }
    checkDeadline(deadline);
  }
  const serialized = canonical(state);
  if (Buffer.byteLength(serialized) > maxMetadataBytes)
    throw new AgentError(
      "FORK_SIZE",
      "Saved boundary metadata exceeds its limit",
    );
  decodeBoundary(serialized);
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
  if (record.stateAvailable) {
    try {
      record.payload.prefixDigest = prefixDigest(
        store,
        record.sessionId,
        messageSeq,
      );
      if (Buffer.byteLength(canonical(record.payload)) > maxMetadataBytes)
        throw new AgentError(
          "FORK_SIZE",
          "Boundary metadata exceeds its limit",
        );
    } catch (error) {
      record.stateAvailable = false;
      record.payload = {
        version: 1,
        settings: record.payload.settings,
        context: emptyConversationContext(),
        images: [],
        preparedInputs: [],
        artifacts: [],
        policy: {
          ...record.payload.policy,
          excluded: emptyConversationContext(),
        },
        unavailableReason:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "保存上限を超えました。",
      };
    }
  }
  const payload = canonical(record.payload);
  record.hash = sha256(payload);
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
      excluded: emptyConversationContext(),
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
    try {
      const state = boundaryState(boundary.payload);
      unavailableReason =
        state.unavailableReason ??
        (!state.prefixDigest
          ? "旧形式の保存状態です。会話本文のみ分岐できます。"
          : undefined);
      stateAvailable &&= !!state.prefixDigest;
    } catch (error) {
      stateAvailable = false;
      unavailableReason =
        error instanceof Error ? error.message : "保存状態が不正です。";
    }
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
  return decodeBoundary(row.payload, row.hash);
}
export async function restoreBoundaryTree(
  paths: Paths,
  runDir: string,
  treeSnapshot: TreeSnapshot,
  config: Config,
  deadline = Date.now() + 30_000,
): Promise<void> {
  await restoreTree(paths, runDir, treeSnapshot, config, deadline);
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
