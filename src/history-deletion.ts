import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import lockfile from "proper-lockfile";
import { configHash, validateConfig, type Config } from "./config.js";
import type { Store } from "./storage.js";
import { AgentError, terminalStates, type Run } from "./types.js";
import { canonical, id, sha256 } from "./util.js";

const tables = [
  "runs",
  "events",
  "operations",
  "requests",
  "artifacts",
  "cooldowns",
  "conversations",
  "conversation_runs",
  "messages",
  "source_links",
  "boundaries",
  "message_boundaries",
  "boundary_artifacts",
  "fork_lineages",
  "deletion_queue",
] as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const maxRows = 100_000;
const maxBytes = 64_000_000;
const maxUnits = 500;
const maxConfigBytes = 4_000_000;
const maxQueueBytes = 32_000_000;
const sqlChunkSize = 400;
const staleAfter = 15_000;
const deletionVersion = 1;
const snapshotTimeoutMs = 10_000;

export type HistoryDeletionRequest =
  | {
      kind: "selection";
      conversationIds: string[];
      runIds: string[];
      workspace?: string;
    }
  | { kind: "retention"; cutoff: number; workspace?: string };

export interface DeletionOptions {
  currentSessionId?: string;
  lease?: { runId: string; generation: number };
  beforeCommit?: () => void;
  signal?: AbortSignal;
}

export interface HistoryDeletionPreview {
  request: HistoryDeletionRequest;
  binding: string;
  conversationIds: string[];
  runIds: string[];
  retained: Array<{
    kind: "conversation" | "run";
    id: string;
    name: string;
    reason: string;
  }>;
  counts: { messages: number; artifacts: number; events: number };
  moreCandidates: number;
}

export interface DeletionResult {
  removedConversations: string[];
  removedRuns: string[];
  pendingCleanup: Array<{ id: string; runIds: string[]; error?: string }>;
}

export interface DeletionCleanupPreview {
  jobs: Array<{ id: string; runIds: string[]; error?: string }>;
  binding: string;
}

interface CleanupOptions {
  preview?: DeletionCleanupPreview;
  signal?: AbortSignal;
  beforeCleanup?: () => void;
}

interface Identity {
  dev: string;
  ino: string;
}
interface QueueRecord {
  version: number;
  runIds: string[];
  root: Identity;
  directories: Array<{
    runId: string;
    identity: Identity | null;
  }>;
  error?: string;
}
interface SnapshotRow {
  table: string;
  row: Record<string, unknown>;
  text: string;
}
interface Snapshot {
  rows: SnapshotRow[];
  binding: string;
  deadline: number;
}
interface Unit {
  key: string;
  kind: "conversation" | "run";
  id: string;
  name: string;
  workspace?: string;
  runIds: string[];
}
interface Plan {
  preview: HistoryDeletionPreview;
  units: Map<string, Unit>;
  deletion: Set<string>;
  selected: Set<string>;
  runDirectories: QueueRecord["directories"];
  configBinding: { hash: string; bytesHash: string } | null;
}

function fail(code: string, message: string): never {
  throw new AgentError(code, message);
}

function checkSignal(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function ensureUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !uuid.test(value))
    fail("DELETE_UNSAFE", `${label} is not a valid UUID`);
  return value;
}

function identity(stat: {
  dev: number | bigint;
  ino: number | bigint;
}): Identity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameIdentity(a: Identity | null, b: Identity | null): boolean {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino;
}

function privateDirectory(path: string, label: string): Identity {
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch {
    fail("DELETE_UNSAFE", `${label} is missing`);
  }
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !owned(stat.uid) ||
    (stat.mode & 0o077n) !== 0n
  )
    fail("DELETE_UNSAFE", `${label} must be an owned private directory`);
  return identity(stat);
}

function owned(uid: number | bigint): boolean {
  return !process.getuid || BigInt(process.getuid()) === BigInt(uid);
}

function sameConfigStat(a: Stats, b: Stats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.nlink === b.nlink &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function storageRoot(store: Store): { path: string; identity: Identity } {
  const homePath = resolve(store.paths.home);
  const runsPath = resolve(store.paths.runs);
  if (runsPath !== join(homePath, "runs"))
    fail("DELETE_UNSAFE", "The run storage root must be home/runs");
  privateDirectory(homePath, "Agent home");
  const rootIdentity = privateDirectory(runsPath, "Run storage root");
  let home: string;
  let runs: string;
  try {
    home = resolve(realpathSync(homePath));
    runs = resolve(realpathSync(runsPath));
  } catch {
    fail("DELETE_UNSAFE", "The run storage root cannot be resolved");
  }
  if (runs !== join(home, "runs"))
    fail("DELETE_UNSAFE", "The run storage root must be home/runs");
  return { path: runs, identity: rootIdentity };
}

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw error;
  }
}

function readConfigBinding(
  store: Store,
  config: Config | undefined,
): { hash: string; bytesHash: string } | null {
  if (!config) return null;
  let before: Stats;
  try {
    before = lstatSync(store.paths.config);
  } catch {
    fail("CONFIG_CHANGED", "Configuration is missing");
  }
  if (
    !before.isFile() ||
    (before.mode & 0o170000) !== 0o100000 ||
    before.nlink !== 1 ||
    !owned(before.uid) ||
    (before.mode & 0o077) !== 0 ||
    before.size > maxConfigBytes
  )
    fail("CONFIG_CHANGED", "Configuration is not a private regular file");
  let fd: number;
  try {
    fd = openSync(
      store.paths.config,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch {
    fail("CONFIG_CHANGED", "Configuration cannot be safely opened");
  }
  let bytes: Buffer;
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameConfigStat(before, opened))
      fail("CONFIG_CHANGED", "Configuration changed while it was opened");
    bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count)
        fail("CONFIG_CHANGED", "Configuration changed while it was read");
      offset += count;
    }
    if (!sameConfigStat(opened, fstatSync(fd)))
      fail("CONFIG_CHANGED", "Configuration changed while it was read");
  } finally {
    closeSync(fd);
  }
  if (bytes.length !== before.size)
    fail("CONFIG_CHANGED", "Configuration changed while it was read");
  const parsed = validateConfig(parse(bytes.toString(), { maxAliasCount: 0 }));
  if (configHash(parsed) !== configHash(config))
    fail("CONFIG_CHANGED", "Configuration changed; reload it before deleting");
  const after = lstatSync(store.paths.config);
  if (!sameConfigStat(before, after))
    fail("CONFIG_CHANGED", "Configuration changed while it was read");
  return { hash: configHash(config), bytesHash: sha256(bytes) };
}

function normalizeRequest(
  request: HistoryDeletionRequest,
): HistoryDeletionRequest {
  if (request.kind === "retention") {
    if (!Number.isSafeInteger(request.cutoff))
      fail("DELETE_REQUEST", "Retention cutoff must be an integer");
    return {
      kind: "retention",
      cutoff: request.cutoff,
      ...(request.workspace ? { workspace: resolve(request.workspace) } : {}),
    };
  }
  if (!Array.isArray(request.conversationIds) || !Array.isArray(request.runIds))
    fail("DELETE_REQUEST", "Selection IDs must be arrays");
  const conversationIds = [...new Set(request.conversationIds)].map((value) =>
    ensureUuid(value, "Conversation ID"),
  );
  const runIds = [...new Set(request.runIds)].map((value) =>
    ensureUuid(value, "Run ID"),
  );
  if (!conversationIds.length && !runIds.length)
    fail("DELETE_REQUEST", "Selection cannot be empty");
  if (conversationIds.length + runIds.length > maxUnits)
    fail("DELETE_LIMIT", "A deletion selection is too large");
  return {
    kind: "selection",
    conversationIds: conversationIds.sort(),
    runIds: runIds.sort(),
    ...(request.workspace ? { workspace: resolve(request.workspace) } : {}),
  };
}

function snapshot(store: Store): Snapshot {
  const rows: SnapshotRow[] = [];
  let bytes = 0;
  const deadline = Date.now() + snapshotTimeoutMs;
  const digest = createHash("sha256");
  for (const table of tables) {
    if (
      table === "deletion_queue" &&
      !store.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)
    )
      continue;
    const query = `SELECT * FROM ${table} ORDER BY rowid`;
    let rowCount = 0;
    for (const raw of store.db.prepare(query).iterate()) {
      if (Date.now() >= deadline)
        fail("DELETE_LIMIT", "Deletion metadata scan timed out");
      if (++rowCount > maxRows || rows.length >= maxRows)
        fail("DELETE_LIMIT", "Deletion metadata row limit exceeded");
      const row = { ...(raw as Record<string, unknown>) };
      const fingerprint = { ...row };
      if (table === "runs" || table === "conversations")
        delete fingerprint.heartbeat;
      if (table === "conversations") delete fingerprint.updated_at;
      const text = canonical(fingerprint);
      bytes += Buffer.byteLength(text);
      if (bytes > maxBytes)
        fail("DELETE_LIMIT", "Deletion metadata is too large");
      rows.push({ table, row, text });
      digest.update(table);
      digest.update("\0");
      digest.update(text);
      digest.update("\0");
    }
  }
  return { rows, binding: digest.digest("hex"), deadline };
}

function payload(row: SnapshotRow): Record<string, unknown> {
  try {
    const value = JSON.parse(String(row.row.payload));
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("DELETE_UNSAFE", `Malformed ${row.table} payload`);
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    fail("DELETE_UNSAFE", `Malformed ${row.table} payload`);
  }
}

function rowId(row: SnapshotRow): string | undefined {
  return typeof row.row.id === "string" ? row.row.id : undefined;
}

function buildUnits(snapshotValue: Snapshot): {
  units: Map<string, Unit>;
  conversations: Map<string, Unit>;
  runUnits: Map<string, string>;
  artifactUnits: Map<string, string>;
  boundaryUnits: Map<string, string>;
  idUnits: Map<string, Set<string>>;
} {
  const conversations = new Map<string, Unit>();
  const runs = new Map<string, Run>();
  const runUnits = new Map<string, string>();
  for (const item of snapshotValue.rows) {
    if (item.table === "conversations") {
      const idValue = ensureUuid(item.row.id, "Conversation row ID");
      const data = payload(item);
      if (!Number.isSafeInteger(item.row.updated_at))
        fail("DELETE_UNSAFE", "Conversation timestamp is malformed");
      conversations.set(idValue, {
        key: `conversation:${idValue}`,
        kind: "conversation",
        id: idValue,
        name: typeof data.name === "string" ? data.name : idValue,
        workspace:
          typeof item.row.workspace === "string"
            ? resolve(item.row.workspace)
            : undefined,
        runIds: [],
      });
    }
    if (item.table === "runs") {
      const idValue = ensureUuid(item.row.id, "Run row ID");
      const data = payload(item) as unknown as Run;
      if (!Number.isSafeInteger(data.updatedAt))
        fail("DELETE_UNSAFE", "Run timestamp is malformed");
      runs.set(idValue, data);
    }
  }
  for (const item of snapshotValue.rows) {
    if (item.table !== "conversation_runs") continue;
    const sessionId = ensureUuid(item.row.session_id, "Conversation link ID");
    const runId = ensureUuid(item.row.run_id, "Conversation run ID");
    const conversation = conversations.get(sessionId);
    if (!conversation || !runs.has(runId))
      fail("DELETE_UNSAFE", "Conversation/run ownership is malformed");
    conversation.runIds.push(runId);
    runUnits.set(runId, conversation.key);
  }
  const units = new Map<string, Unit>(
    [...conversations.values()].map((unit) => [unit.key, unit]),
  );
  for (const [runId, run] of runs) {
    if (runUnits.has(runId)) continue;
    units.set(`run:${runId}`, {
      key: `run:${runId}`,
      kind: "run",
      id: runId,
      name: typeof run.objective === "string" ? run.objective : runId,
      workspace: run.workspace ? resolve(run.workspace) : undefined,
      runIds: [runId],
    });
    runUnits.set(runId, `run:${runId}`);
  }
  const artifactUnits = new Map<string, string>();
  const boundaryUnits = new Map<string, string>();
  for (const item of snapshotValue.rows) {
    if (item.table === "artifacts") {
      const artifactId = ensureUuid(item.row.id, "Artifact row ID");
      const runId = ensureUuid(item.row.run_id, "Artifact run ID");
      const unit = runUnits.get(runId);
      if (!unit) fail("DELETE_UNSAFE", "Artifact producer is not retained");
      artifactUnits.set(artifactId, unit);
    } else if (item.table === "boundaries") {
      const boundaryId = ensureUuid(item.row.id, "Boundary row ID");
      const sessionId = ensureUuid(item.row.session_id, "Boundary session ID");
      const unit = conversations.get(sessionId);
      if (!unit) fail("DELETE_UNSAFE", "Boundary conversation is not retained");
      boundaryUnits.set(boundaryId, unit.key);
    }
  }
  const idUnits = new Map<string, Set<string>>();
  const addId = (idValue: string, key: string) => {
    const set = idUnits.get(idValue) ?? new Set<string>();
    set.add(key);
    idUnits.set(idValue, set);
  };
  for (const unit of units.values()) {
    addId(unit.id, unit.key);
    for (const runId of unit.runIds) addId(runId, unit.key);
  }
  for (const [artifactId, unit] of artifactUnits) addId(artifactId, unit);
  for (const [boundaryId, unit] of boundaryUnits) addId(boundaryId, unit);
  return {
    units,
    conversations,
    runUnits,
    artifactUnits,
    boundaryUnits,
    idUnits,
  };
}

function unitForRow(
  row: SnapshotRow,
  maps: ReturnType<typeof buildUnits>,
): string | undefined {
  if (row.table === "conversations") {
    const value = rowId(row);
    return value && maps.conversations.get(value)?.key;
  }
  if (row.table === "conversation_runs") {
    return typeof row.row.session_id === "string"
      ? maps.conversations.get(row.row.session_id)?.key
      : undefined;
  }
  if (
    row.table === "runs" ||
    row.table === "events" ||
    row.table === "operations" ||
    row.table === "requests" ||
    row.table === "artifacts" ||
    row.table === "source_links"
  ) {
    const runId =
      row.table === "runs"
        ? rowId(row)
        : typeof row.row.run_id === "string"
          ? row.row.run_id
          : undefined;
    return runId ? maps.runUnits.get(runId) : undefined;
  }
  if (row.table === "messages" || row.table === "boundaries") {
    const sessionId =
      row.table === "boundaries" ? row.row.session_id : row.row.session_id;
    return typeof sessionId === "string"
      ? maps.conversations.get(sessionId)?.key
      : undefined;
  }
  if (row.table === "message_boundaries") {
    return typeof row.row.session_id === "string"
      ? maps.conversations.get(row.row.session_id)?.key
      : undefined;
  }
  if (row.table === "boundary_artifacts") {
    const boundaryId = String(row.row.boundary_id);
    return maps.boundaryUnits.get(boundaryId);
  }
  if (row.table === "fork_lineages") {
    return typeof row.row.child_session_id === "string"
      ? maps.conversations.get(row.row.child_session_id)?.key
      : undefined;
  }
  return undefined;
}

function refsAndRetention(
  snapshotValue: Snapshot,
  maps: ReturnType<typeof buildUnits>,
  candidates: Set<string>,
  initialReasons: Map<string, string[]>,
): { reasons: Map<string, string[]>; edges: Map<string, Set<string>> } {
  const reasons = new Map(
    [...initialReasons]
      .filter(([key]) => candidates.has(key))
      .map(([key, values]) => [key, [...values]]),
  );
  const edges = new Map<string, Set<string>>();
  const uuidPattern =
    /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi;
  const retain = (key: string, reason: string, pending: string[]) => {
    if (!candidates.has(key)) return;
    const list = reasons.get(key) ?? [];
    if (list.includes(reason)) return;
    list.push(reason);
    reasons.set(key, list);
    if (list.length === 1) pending.push(key);
  };
  const pending = [...reasons.keys()];
  for (const item of snapshotValue.rows) {
    if (Date.now() >= snapshotValue.deadline)
      fail("DELETE_LIMIT", "Deletion reference scan timed out");
    const owner = unitForRow(item, maps);
    const matches = new Set<string>();
    for (const match of item.text.matchAll(uuidPattern)) {
      for (const key of maps.idUnits.get(match[0].toLowerCase()) ?? [])
        matches.add(key);
    }
    for (const target of matches) {
      if (target === owner) continue;
      if (owner && candidates.has(owner)) {
        const targets = edges.get(owner) ?? new Set<string>();
        targets.add(target);
        edges.set(owner, targets);
      } else retain(target, `外部の${item.table}参照`, pending);
    }
  }
  for (let index = 0; index < pending.length; index++) {
    if (Date.now() >= snapshotValue.deadline)
      fail("DELETE_LIMIT", "Deletion reference propagation timed out");
    const source = pending[index]!;
    for (const target of edges.get(source) ?? []) {
      if (!reasons.has(target))
        retain(target, "保持された履歴からの参照", pending);
    }
  }
  return { reasons, edges };
}

function addReason(
  reasons: Map<string, string[]>,
  key: string,
  reason: string,
) {
  const list = reasons.get(key) ?? [];
  if (!list.includes(reason)) list.push(reason);
  reasons.set(key, list);
}

function runRows(snapshotValue: Snapshot): Map<string, SnapshotRow> {
  return new Map(
    snapshotValue.rows
      .filter((row) => row.table === "runs")
      .map((row) => [ensureUuid(row.row.id, "Run ID"), row]),
  );
}

function preparePlan(
  store: Store,
  config: Config | undefined,
  requestInput: HistoryDeletionRequest,
  options: DeletionOptions,
): Plan {
  checkSignal(options.signal);
  const request = normalizeRequest(requestInput);
  if (!config && request.kind === "retention")
    fail("CONFIG", "Retention deletion requires current configuration");
  if (!config && !options.lease)
    fail("CONFIG", "A configuration is required for history deletion");
  if (options.lease)
    store.assertLease(options.lease.runId, options.lease.generation);
  const storage = storageRoot(store);
  const snapshotValue = snapshot(store);
  const maps = buildUnits(snapshotValue);
  const runData = runRows(snapshotValue);
  const conversationData = new Map(
    snapshotValue.rows
      .filter((row) => row.table === "conversations")
      .map((row) => [String(row.row.id), row]),
  );
  const operationStates = new Map<string, Set<string>>();
  const requestStates = new Map<string, Set<string>>();
  const addStatus = (
    index: Map<string, Set<string>>,
    row: SnapshotRow,
  ): void => {
    if (typeof row.row.run_id !== "string") return;
    const values = index.get(row.row.run_id) ?? new Set<string>();
    values.add(String(row.row.status));
    index.set(row.row.run_id, values);
  };
  for (const row of snapshotValue.rows) {
    if (row.table === "operations") addStatus(operationStates, row);
    if (row.table === "requests") addStatus(requestStates, row);
  }
  const hasUnresolved = (
    index: Map<string, Set<string>>,
    runId: string,
    unresolved: readonly string[],
  ) => unresolved.some((status) => index.get(runId)?.has(status));
  const liveCutoff = Date.now() - staleAfter;
  const runIsLive = (runId: string): boolean => {
    const row = runData.get(runId)?.row;
    if (
      !row ||
      typeof row.heartbeat !== "number" ||
      row.heartbeat <= liveCutoff
    )
      return false;
    return !(
      options.lease?.runId === runId &&
      options.lease.generation === row.generation
    );
  };
  const reasons = new Map<string, string[]>();
  const selected = new Set<string>();
  const explicitConversations = new Set(
    request.kind === "selection" ? request.conversationIds : [],
  );
  const addSelected = (key: string, reason?: string) => {
    selected.add(key);
    if (reason) addReason(reasons, key, reason);
  };
  let moreCandidates = 0;
  if (request.kind === "selection") {
    for (const sessionId of request.conversationIds) {
      const unit = maps.conversations.get(sessionId);
      if (!unit) fail("NOT_FOUND", `Unknown conversation: ${sessionId}`);
      addSelected(unit.key);
    }
    for (const runId of request.runIds) {
      const key = maps.runUnits.get(runId);
      if (!key) fail("NOT_FOUND", `Unknown run: ${runId}`);
      const unit = maps.units.get(key)!;
      addSelected(
        key,
        unit.kind === "conversation" && !explicitConversations.has(unit.id)
          ? "選択した run は会話に属しています"
          : undefined,
      );
    }
  } else {
    const eligible = [...maps.units.values()]
      .filter((unit) => {
        if (request.workspace && unit.workspace !== request.workspace)
          return false;
        if (unit.kind === "conversation") {
          const row = conversationData.get(unit.id)!;
          return Number(row.row.updated_at) <= request.cutoff;
        }
        const row = runData.get(unit.id)!;
        const run = payload(row) as unknown as Run;
        return run.updatedAt <= request.cutoff;
      })
      .sort((a, b) => {
        const updatedAt = (unit: Unit) =>
          unit.kind === "conversation"
            ? Number(conversationData.get(unit.id)!.row.updated_at)
            : (payload(runData.get(unit.id)!) as unknown as Run).updatedAt;
        return updatedAt(a) - updatedAt(b) || a.id.localeCompare(b.id);
      });
    moreCandidates = Math.max(0, eligible.length - maxUnits);
    for (const unit of eligible.slice(0, maxUnits)) addSelected(unit.key);
  }
  for (const key of selected) {
    const unit = maps.units.get(key)!;
    if (options.currentSessionId === unit.id)
      addReason(reasons, key, "現在の会話は削除できません");
    if (request.kind === "selection" && request.workspace) {
      if (unit.workspace !== request.workspace)
        addReason(reasons, key, "指定 workspace の範囲外");
    }
    if (unit.kind === "conversation") {
      const conversation = conversationData.get(unit.id)!.row;
      if (
        conversation.owner !== null &&
        conversation.owner !== undefined &&
        typeof conversation.heartbeat === "number" &&
        conversation.heartbeat > liveCutoff
      )
        addReason(reasons, key, "会話が別のプロセスで使用中です");
      for (const runId of unit.runIds) {
        const runRow = runData.get(runId)!;
        if (!terminalStates.includes(String(runRow.row.state) as Run["state"]))
          addReason(reasons, key, "非 terminal run を含みます");
        const run = payload(runRow) as unknown as Run;
        if (
          hasUnresolved(operationStates, runId, [
            "prepared",
            "dispatched",
            "unknown",
          ])
        )
          addReason(reasons, key, "未解決 operation を含みます");
        if (hasUnresolved(requestStates, runId, ["reserved", "unknown"]))
          addReason(reasons, key, "未解決 provider request を含みます");
        if (runIsLive(runId))
          addReason(reasons, key, "run に live lease があります");
        if (request.kind === "retention" && run.updatedAt > request.cutoff)
          addReason(reasons, key, "会話内に cutoff 後の run があります");
      }
    } else {
      const runRow = runData.get(unit.id)!;
      if (!terminalStates.includes(String(runRow.row.state) as Run["state"]))
        addReason(reasons, key, "非 terminal run です");
      if (
        hasUnresolved(operationStates, unit.id, [
          "prepared",
          "dispatched",
          "unknown",
        ])
      )
        addReason(reasons, key, "未解決 operation を含みます");
      if (hasUnresolved(requestStates, unit.id, ["reserved", "unknown"]))
        addReason(reasons, key, "未解決 provider request を含みます");
      if (runIsLive(unit.id))
        addReason(reasons, key, "run に live lease があります");
    }
  }
  const candidateForRefs = new Set(selected);
  const { reasons: refReasons } = refsAndRetention(
    snapshotValue,
    maps,
    candidateForRefs,
    reasons,
  );
  for (const [key, values] of refReasons)
    for (const reason of values) addReason(reasons, key, reason);
  const deletion = new Set(
    [...selected].filter((key) => !(reasons.get(key)?.length ?? 0)),
  );
  const retained = [...selected]
    .filter((key) => reasons.has(key))
    .map((key) => {
      const unit = maps.units.get(key)!;
      return {
        kind: unit.kind,
        id: unit.id,
        name: unit.name,
        reason: (reasons.get(key) ?? ["保持"]).join("、").slice(0, 512),
      };
    });
  const configBinding = readConfigBinding(store, config);
  const directories: QueueRecord["directories"] = [];
  for (const key of deletion) {
    for (const runId of maps.units.get(key)!.runIds) {
      const path = join(storage.path, runId);
      const stat = lstatIfPresent(path);
      if (!stat) {
        directories.push({ runId, identity: null });
        continue;
      }
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !owned(stat.uid) ||
        (stat.mode & 0o077n) !== 0n
      )
        fail("DELETE_UNSAFE", `Run directory is unsafe: ${runId}`);
      directories.push({ runId, identity: identity(stat) });
    }
  }
  const counts = { messages: 0, artifacts: 0, events: 0 };
  for (const item of snapshotValue.rows) {
    const owner = unitForRow(item, maps);
    if (!owner || !deletion.has(owner)) continue;
    if (item.table === "messages") counts.messages++;
    if (item.table === "artifacts") counts.artifacts++;
    if (item.table === "events") counts.events++;
  }
  const conversationIds = [...deletion]
    .map((key) => maps.units.get(key)!)
    .filter((unit) => unit.kind === "conversation")
    .map((unit) => unit.id)
    .sort();
  const runIds = [...deletion]
    .flatMap((key) => maps.units.get(key)!.runIds)
    .sort();
  const more = request.kind === "retention" ? moreCandidates : 0;
  const preview: HistoryDeletionPreview = {
    request,
    binding: "",
    conversationIds,
    runIds,
    retained: retained.sort((a, b) => a.id.localeCompare(b.id)),
    counts,
    moreCandidates: more,
  };
  preview.binding = sha256(
    canonical({
      snapshot: snapshotValue.binding,
      request,
      selected: [...selected].sort(),
      deletion: [...deletion].sort(),
      retained: preview.retained,
      config: configBinding,
      storage,
      directories,
      currentSessionId: options.currentSessionId,
      lease: options.lease,
    }),
  );
  return {
    preview,
    units: maps.units,
    deletion,
    selected,
    runDirectories: directories,
    configBinding,
  };
}

function chunks<T>(values: T[], size = sqlChunkSize): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}

function selectIds(
  store: Store,
  table: "artifacts" | "boundaries",
  column: "run_id" | "session_id",
  values: string[],
): string[] {
  const result: string[] = [];
  for (const group of chunks(values)) {
    result.push(
      ...(
        store.db
          .prepare(
            `SELECT id FROM ${table} WHERE ${column} IN (${group.map(() => "?").join(",")})`,
          )
          .all(...group) as Array<{ id: string }>
      ).map((row) => ensureUuid(row.id, `${table} ID`)),
    );
  }
  return result;
}

function deleteByIds(
  store: Store,
  table: string,
  column: string,
  values: string[],
): void {
  for (const group of chunks(values))
    store.db
      .prepare(
        `DELETE FROM ${table} WHERE ${column} IN (${group.map(() => "?").join(",")})`,
      )
      .run(...group);
}

function deleteMetadata(
  store: Store,
  plan: Plan,
  options: DeletionOptions,
): string[] {
  const runIds = [
    ...new Set(
      [...plan.deletion].flatMap((key) => plan.units.get(key)!.runIds),
    ),
  ].sort();
  const conversationIds = [...plan.deletion]
    .map((key) => plan.units.get(key)!)
    .filter((unit) => unit.kind === "conversation")
    .map((unit) => unit.id)
    .sort();
  const artifactIds = selectIds(store, "artifacts", "run_id", runIds);
  const boundaryIds = selectIds(
    store,
    "boundaries",
    "session_id",
    conversationIds,
  );
  options.signal?.throwIfAborted();
  if (options.lease)
    store.assertLease(options.lease.runId, options.lease.generation);
  options.beforeCommit?.();
  options.signal?.throwIfAborted();
  if (options.lease)
    store.assertLease(options.lease.runId, options.lease.generation);
  const queueId = id();
  const storage = storageRoot(store);
  const queue: QueueRecord = {
    version: deletionVersion,
    runIds,
    root: storage.identity,
    directories: plan.runDirectories,
  };
  const serializedQueue = JSON.stringify(queue);
  if (Buffer.byteLength(serializedQueue) > maxQueueBytes)
    fail("DELETE_LIMIT", "Deletion cleanup intent exceeds its size limit");
  store.db
    .prepare("INSERT INTO deletion_queue VALUES (?,?,?)")
    .run(queueId, Date.now(), serializedQueue);
  deleteByIds(store, "message_boundaries", "boundary_id", boundaryIds);
  deleteByIds(store, "message_boundaries", "session_id", conversationIds);
  deleteByIds(store, "boundary_artifacts", "boundary_id", boundaryIds);
  deleteByIds(store, "boundaries", "session_id", conversationIds);
  deleteByIds(store, "messages", "session_id", conversationIds);
  deleteByIds(store, "source_links", "artifact_id", artifactIds);
  deleteByIds(store, "source_links", "run_id", runIds);
  deleteByIds(store, "fork_lineages", "child_session_id", conversationIds);
  deleteByIds(store, "fork_lineages", "parent_session_id", conversationIds);
  deleteByIds(store, "conversation_runs", "run_id", runIds);
  deleteByIds(store, "conversation_runs", "session_id", conversationIds);
  deleteByIds(store, "conversations", "id", conversationIds);
  deleteByIds(store, "runs", "id", runIds);
  return [queueId];
}

function queueRows(
  store: Store,
  ids?: string[],
): Array<{
  id: string;
  payload: QueueRecord;
}> {
  const rows: Array<{ id: string; payload: string }> = [];
  let bytes = 0;
  const collect = (values: Iterable<unknown>) => {
    for (const value of values) {
      const row = value as { id: string; payload: string };
      bytes += Buffer.byteLength(row.payload);
      if (bytes > maxBytes || rows.length >= maxRows)
        fail("DELETE_LIMIT", "Deletion cleanup metadata exceeds its limits");
      rows.push(row);
    }
  };
  if (ids?.length) {
    if (ids.length > maxRows)
      fail("DELETE_LIMIT", "Too many deletion jobs were requested");
    for (const group of chunks(ids))
      collect(
        store.db
          .prepare(
            `SELECT id,payload FROM deletion_queue WHERE id IN (${group.map(() => "?").join(",")})`,
          )
          .iterate(...group),
      );
  } else {
    collect(
      store.db
        .prepare(
          "SELECT id,payload FROM deletion_queue ORDER BY created_at LIMIT ?",
        )
        .iterate(maxRows + 1),
    );
  }
  return rows.map((row) => {
    try {
      ensureUuid(row.id, "Deletion job ID");
      if (
        typeof row.payload !== "string" ||
        Buffer.byteLength(row.payload) > maxQueueBytes
      )
        throw new Error();
      const raw: unknown = JSON.parse(row.payload);
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error();
      const data = raw as Record<string, unknown>;
      const keys = Object.keys(data).sort();
      if (
        keys.some(
          (key) =>
            !["version", "runIds", "root", "directories", "error"].includes(
              key,
            ),
        ) ||
        data.version !== deletionVersion ||
        !Array.isArray(data.runIds) ||
        data.runIds.length > maxRows ||
        !Array.isArray(data.directories) ||
        data.directories.length !== data.runIds.length
      )
        throw new Error();
      if (
        data.error !== undefined &&
        (typeof data.error !== "string" || data.error.length > 512)
      )
        throw new Error();
      const runIds = data.runIds.map((value) =>
        ensureUuid(value, "Queued run ID"),
      );
      if (new Set(runIds).size !== runIds.length) throw new Error();
      const root = parseQueueIdentity(data.root);
      const directories = data.directories.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error();
        const directory = value as Record<string, unknown>;
        if (Object.keys(directory).sort().join(",") !== "identity,runId")
          throw new Error();
        const runId = ensureUuid(directory.runId, "Queued run ID");
        const identity =
          directory.identity === null
            ? null
            : parseQueueIdentity(directory.identity);
        return { runId, identity };
      });
      const directoryRuns = new Set(
        directories.map((directory) => directory.runId),
      );
      if (
        directoryRuns.size !== directories.length ||
        runIds.some((runId) => !directoryRuns.has(runId))
      )
        throw new Error();
      return {
        id: row.id,
        payload: {
          version: deletionVersion,
          runIds,
          root,
          directories,
          ...(data.error === undefined ? {} : { error: data.error }),
        },
      };
    } catch {
      fail("DELETE_UNSAFE", "Deletion queue contains malformed metadata");
    }
  });
}

function parseQueueIdentity(value: unknown): Identity {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("DELETE_UNSAFE", "Deletion queue contains an invalid identity");
  const identity = value as Record<string, unknown>;
  if (
    Object.keys(identity).sort().join(",") !== "dev,ino" ||
    typeof identity.dev !== "string" ||
    typeof identity.ino !== "string" ||
    !/^(0|[1-9]\d*)$/.test(identity.dev) ||
    !/^(0|[1-9]\d*)$/.test(identity.ino) ||
    identity.dev.length > 64 ||
    identity.ino.length > 64
  )
    fail("DELETE_UNSAFE", "Deletion queue contains an invalid identity");
  return { dev: identity.dev, ino: identity.ino };
}

function cleanupPreview(
  rows: ReturnType<typeof queueRows>,
): DeletionCleanupPreview {
  const sorted = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  return {
    jobs: sorted.map(({ id, payload }) => ({
      id,
      runIds: payload.runIds,
      ...(payload.error ? { error: payload.error } : {}),
    })),
    binding: sha256(canonical(sorted)),
  };
}

export function previewDeletionCleanup(
  store: Store,
  ids: string[],
): DeletionCleanupPreview {
  const unique = [...new Set(ids)].map((value) =>
    ensureUuid(value, "Deletion job ID"),
  );
  if (!unique.length || unique.length > maxUnits)
    fail("DELETE_LIMIT", "Select between 1 and 500 cleanup jobs");
  const rows = queueRows(store, unique);
  if (rows.length !== unique.length)
    fail("NOT_FOUND", "A requested deletion job does not exist");
  return cleanupPreview(rows);
}

async function cleanupJobs(
  store: Store,
  ids: string[],
  options: CleanupOptions = {},
): Promise<void> {
  if (!ids.length) return;
  const jobs = store.transaction(() => {
    const rows = queueRows(store, ids);
    if (
      options.preview &&
      canonical(cleanupPreview(rows)) !== canonical(options.preview)
    )
      fail("STALE_VIEW", "Cleanup preview is stale; choose it again");
    options.beforeCleanup?.();
    return rows;
  });
  for (const job of jobs) {
    let error: string | undefined;
    try {
      const currentRoot = storageRoot(store);
      if (!sameIdentity(currentRoot.identity, job.payload.root))
        throw new AgentError(
          "DELETE_CLEANUP",
          "Run storage root identity changed",
        );
      for (const directory of job.payload.directories) {
        checkSignal(options.signal);
        ensureUuid(directory.runId, "Queued run ID");
        if (
          store.db.prepare("SELECT 1 FROM runs WHERE id=?").get(directory.runId)
        )
          throw new AgentError("DELETE_CLEANUP", "Run ID was reused");
        const path = join(currentRoot.path, directory.runId);
        const current = lstatIfPresent(path);
        if (!directory.identity) {
          if (current)
            throw new AgentError(
              "DELETE_CLEANUP",
              "A directory appeared after metadata deletion",
            );
          continue;
        }
        if (!current) continue;
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          !sameIdentity(identity(current), directory.identity)
        )
          throw new AgentError(
            "DELETE_CLEANUP",
            "Run directory identity changed; cleanup was retained",
          );
        await fs.rm(path, { recursive: true, force: true });
        if (lstatIfPresent(path))
          throw new AgentError("DELETE_CLEANUP", "Run directory remains");
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    store.transaction(() => {
      const current = queueRows(store, [job.id])[0];
      if (!current) return;
      if (error) {
        current.payload.error = error.slice(0, 512);
        store.db
          .prepare("UPDATE deletion_queue SET payload=? WHERE id=?")
          .run(JSON.stringify(current.payload), job.id);
      } else {
        store.db.prepare("DELETE FROM deletion_queue WHERE id=?").run(job.id);
      }
    });
  }
}

export function previewHistoryDeletion(
  store: Store,
  config: Config | undefined,
  request: HistoryDeletionRequest,
  options: DeletionOptions = {},
): HistoryDeletionPreview {
  checkSignal(options.signal);
  return store.transaction(
    () => preparePlan(store, config, request, options).preview,
  );
}

export async function confirmHistoryDeletion(
  store: Store,
  config: Config | undefined,
  preview: HistoryDeletionPreview,
  options: DeletionOptions = {},
): Promise<DeletionResult> {
  checkSignal(options.signal);
  if (!config && !options.lease)
    fail("CONFIG", "A configuration is required for history deletion");
  let releaseConfig: (() => Promise<void>) | undefined;
  let releaseDatabase: (() => Promise<void>) | undefined;
  let queueIds: string[] = [];
  try {
    if (config)
      releaseConfig = await lockfile.lock(store.paths.config, {
        retries: 0,
        stale: 30_000,
      });
    checkSignal(options.signal);
    releaseDatabase = await lockfile.lock(store.paths.database, {
      retries: 0,
      stale: 30_000,
    });
    checkSignal(options.signal);
    const plan = store.transaction(() => {
      const current = preparePlan(store, config, preview.request, options);
      if (canonical(current.preview) !== canonical(preview))
        fail("STALE_VIEW", "Deletion preview is stale; choose it again");
      if (
        preview.request.kind === "selection" &&
        current.preview.retained.length
      )
        fail(
          "SESSION_REFERENCE",
          "The selected history has references or unresolved activity",
        );
      if (
        current.preview.conversationIds.length === 0 &&
        current.preview.runIds.length === 0
      )
        fail("DELETE_REQUEST", "No deletable history remains");
      queueIds = deleteMetadata(store, current, options);
      return current;
    });
    await cleanupJobs(store, queueIds, { signal: options.signal });
    const remaining = cleanupPreview(queueRows(store, queueIds)).jobs;
    return {
      removedConversations: plan.preview.conversationIds,
      removedRuns: [
        ...new Set(
          [...plan.deletion].flatMap((key) => plan.units.get(key)!.runIds),
        ),
      ].sort(),
      pendingCleanup: remaining,
    };
  } finally {
    try {
      await releaseDatabase?.();
    } finally {
      await releaseConfig?.();
    }
  }
}

export function pendingDeletions(
  store: Store,
): Array<{ id: string; runIds: string[]; error?: string }> {
  return cleanupPreview(queueRows(store)).jobs;
}

export async function retryDeletionCleanup(
  store: Store,
  ids: string[],
  options: CleanupOptions = {},
): Promise<Array<{ id: string; runIds: string[]; error?: string }>> {
  checkSignal(options.signal);
  const unique = [...new Set(ids)].map((value) =>
    ensureUuid(value, "Deletion job ID"),
  );
  if (!unique.length) {
    if (options.preview)
      fail("STALE_VIEW", "Cleanup preview has no selected jobs");
    return pendingDeletions(store);
  }
  if (unique.length > maxUnits)
    fail("DELETE_LIMIT", "Too many cleanup jobs were requested");
  const release = await lockfile.lock(store.paths.database, {
    retries: 0,
    stale: 30_000,
  });
  try {
    checkSignal(options.signal);
    const jobs = queueRows(store, unique);
    if (jobs.length !== unique.length)
      fail("NOT_FOUND", "A requested deletion job does not exist");
    await cleanupJobs(store, unique, options);
    return cleanupPreview(queueRows(store, unique)).jobs;
  } finally {
    await release();
  }
}
