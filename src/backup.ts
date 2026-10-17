import { createHash } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import lockfile from "proper-lockfile";
import { parse } from "yaml";
import { z } from "zod";
import { configHash, validateConfig, type Config } from "./config.js";
import type { Store } from "./storage.js";
import { AgentError } from "./types.js";
import { canonical, sha256, within } from "./util.js";

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
const digest = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const limitsSchema = z
  .strictObject({
    maxBytes: z
      .number()
      .int()
      .min(1000)
      .max(5_000_000_000)
      .default(512_000_000),
    maxFiles: z.number().int().min(1).max(100_000).default(50_000),
    timeoutMs: z.number().int().min(1).max(120_000).default(30_000),
  })
  .prefault({});
export type BackupLimits = z.input<typeof limitsSchema>;
export interface BackupOwner {
  sessionId: string;
  owner: string;
}
export interface BackupPreview {
  destination: string;
  binding: string;
  files: number;
  estimatedBytes: number;
  conversations: number;
  runs: number;
  configBytesHash: string;
  preferencesBytesHash?: string;
  limits: z.output<typeof limitsSchema>;
}
interface BlobReference {
  path: string;
  sha256?: string;
  bytes?: number;
}
const entrySchema = z.strictObject({
  path: z.string().max(512),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(digest),
});
const manifestSchema = z.strictObject({
  format: z.literal("local-agent-history-backup"),
  version: z.literal(1),
  createdAt: z.number().int().nonnegative(),
  configHash: z.string().regex(digest),
  scope: z.literal("committed-history-and-evidence"),
  excluded: z.array(z.string().max(256)).max(20),
  files: z.array(entrySchema).max(100_000),
});
export type BackupManifest = z.infer<typeof manifestSchema>;
export const backupExclusions = [
  "資格情報ストア・環境変数・設定の旧版",
  "稼働中プロセス・モデル内部セッション・未保存の作業コピー・依存環境",
  "参照されていない添付・チェックポイントのキャッシュ",
  "自動復元・自動再開（復元用の実行環境ではありません）",
  "削除済み履歴の物理 cleanup 待ちの remnants（自動実行しません）",
];

function fail(message: string): never {
  throw new AgentError("BACKUP_UNSAFE", message);
}
function deadlineCheck(deadline: number): void {
  if (Date.now() >= deadline)
    throw new AgentError(
      "BACKUP_LIMIT",
      "バックアップの処理時間上限を超えました。",
    );
}
function owned(stat: Stats): boolean {
  return !process.getuid || stat.uid === process.getuid();
}
function directory(path: string): Stats {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !owned(stat) ||
    stat.mode & 0o022
  )
    fail("バックアップには所有する書込保護済みディレクトリが必要です。");
  return stat;
}
function parents(root: string, path: string): void {
  if (!within(root, path) || root === path) fail("保存パスが範囲外です。");
  directory(root);
  let current = root;
  for (const part of relative(root, dirname(path))
    .split(/[\\/]/)
    .filter(Boolean)) {
    current = join(current, part);
    directory(current);
  }
}
function sameFile(a: Stats, b: Stats): boolean {
  return [
    "dev",
    "ino",
    "size",
    "mtimeMs",
    "ctimeMs",
    "mode",
    "uid",
    "nlink",
  ].every((key) => a[key as keyof Stats] === b[key as keyof Stats]);
}
function withSafeFile<T>(
  root: string,
  path: string,
  maxBytes: number,
  read: (fd: number, size: number) => T,
): T {
  parents(root, path);
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    !owned(before) ||
    before.mode & 0o022 ||
    before.size > maxBytes
  )
    fail(
      "リンク・特殊ファイル・上限超過・書込保護されていないファイルは保存できません。",
    );
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!sameFile(before, fstatSync(fd)))
      fail("読取前にファイルが変化しました。");
    const result = read(fd, before.size);
    if (!sameFile(before, fstatSync(fd)) || !sameFile(before, lstatSync(path)))
      fail("読取中にファイルが変化しました。");
    return result;
  } finally {
    closeSync(fd);
  }
}
function readSafe(root: string, path: string, maxBytes: number): Buffer {
  return withSafeFile(root, path, maxBytes, (fd, size) => {
    const data = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const bytes = readSync(fd, data, offset, size - offset, offset);
      if (!bytes) fail("ファイルを最後まで読めませんでした。");
      offset += bytes;
    }
    return data;
  });
}
function hashSafe(
  root: string,
  path: string,
  maxBytes: number,
  deadline: number,
): { bytes: number; sha256: string } {
  return withSafeFile(root, path, maxBytes, (fd, size) => {
    const buffer = Buffer.alloc(Math.min(size, 1_000_000));
    const hash = createHash("sha256");
    let offset = 0;
    while (offset < size) {
      deadlineCheck(deadline);
      const bytes = readSync(
        fd,
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      );
      if (!bytes) fail("ファイルを最後まで読めませんでした。");
      hash.update(buffer.subarray(0, bytes));
      offset += bytes;
    }
    return { bytes: size, sha256: hash.digest("hex") };
  });
}
function archivePath(path: string): string {
  return path === "config.yaml"
    ? "configuration.yaml"
    : path === "terminal.json"
      ? path
      : `files/${path}`;
}
function safeArchivePath(path: string): boolean {
  return (
    path === "metadata.sqlite" ||
    path === "configuration.yaml" ||
    path === "terminal.json" ||
    /^files\/(?:images\/[a-f0-9]{64}\.img|attachments\/(?:[a-f0-9]{64}\.raw|doc-[a-f0-9]{64}\.selected)|checkpoints\/blobs\/[a-f0-9]{64}|runs\/[a-f0-9-]{36}\/artifacts\/[a-f0-9]{64})$/.test(
      path,
    )
  );
}

function snapshotMetadata(db: DatabaseSync, deadline: number) {
  const hash = createHash("sha256");
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
  const references = new Map<string, BlobReference>();
  let rows = 0,
    bytes = 0,
    conversations = 0,
    runs = 0;
  const add = (path: string, expectedHash: unknown, expectedBytes: unknown) => {
    if (
      typeof expectedHash !== "string" ||
      !digest.test(expectedHash) ||
      typeof expectedBytes !== "number" ||
      !Number.isSafeInteger(expectedBytes) ||
      expectedBytes < 0
    )
      fail("保存済み資料の参照が不正です。");
    const previous = references.get(path);
    if (
      previous &&
      (previous.sha256 !== expectedHash || previous.bytes !== expectedBytes)
    )
      fail("同じ資料の参照が矛盾しています。");
    references.set(path, { path, sha256: expectedHash, bytes: expectedBytes });
  };
  const inputs = (value: unknown, depth = 0): void => {
    if (depth > 100) fail("保存済みメタデータの入れ子が深すぎます。");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) inputs(item, depth + 1);
      return;
    }
    const item = value as Record<string, unknown>;
    if (typeof item.id === "string" && /^img-[a-f0-9]{64}$/.test(item.id)) {
      if (item.sha256 !== item.id.slice(4)) fail("画像参照が不正です。");
      add(`images/${item.id.slice(4)}.img`, item.sha256, item.bytes);
    }
    if (typeof item.id === "string" && /^doc-[a-f0-9]{64}$/.test(item.id)) {
      add(
        `attachments/${String(item.rawSha256)}.raw`,
        item.rawSha256,
        item.rawBytes,
      );
      add(
        `attachments/${item.id}.selected`,
        item.selectedSha256,
        item.selectedBytes,
      );
    }
    for (const child of Object.values(item)) inputs(child, depth + 1);
  };
  for (const table of tables) {
    if (
      table === "deletion_queue" &&
      (version < 4 ||
        !db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table))
    )
      continue;
    hash.update(table);
    for (const raw of db
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .iterate()) {
      deadlineCheck(deadline);
      if (++rows > 100_000)
        fail("保存済みメタデータが件数上限を超えています。");
      const row = { ...raw };
      if (table === "runs" || table === "conversations") delete row.heartbeat;
      if (table === "conversations") {
        delete row.updated_at;
        conversations++;
      }
      if (table === "runs") runs++;
      const encoded = canonical(row);
      bytes += Buffer.byteLength(encoded);
      if (bytes > 64_000_000)
        fail("保存済みメタデータがサイズ上限を超えています。");
      hash.update(encoded + "\n");
      if (typeof row.payload !== "string") continue;
      const value = JSON.parse(row.payload) as Record<string, unknown>;
      if (table === "artifacts") {
        if (
          typeof value.runId !== "string" ||
          !uuid.test(value.runId) ||
          value.runId !== row.run_id ||
          value.id !== row.id
        )
          fail("成果物の実行IDが不正です。");
        add(
          `runs/${value.runId}/artifacts/${String(value.sha256)}`,
          value.sha256,
          value.bytes,
        );
      }
      if (
        table === "runs" ||
        table === "conversations" ||
        table === "boundaries"
      )
        inputs(value);
      if (table === "boundaries") {
        if (sha256(row.payload) !== row.hash)
          fail("保存境界の内容が検証値と一致しません。");
        for (const kind of ["coding", "document"]) {
          const tree = value[kind] as
            { baseline?: unknown[]; work?: unknown[] } | undefined;
          if (!tree) continue;
          for (const item of [...(tree.baseline ?? []), ...(tree.work ?? [])]) {
            const file = item as Record<string, unknown>;
            add(
              `checkpoints/blobs/${String(file.hash)}`,
              file.hash,
              file.bytes,
            );
          }
        }
      }
    }
  }
  return { binding: hash.digest("hex"), references, conversations, runs };
}

function assertQuiescent(store: Store, owner?: BackupOwner): void {
  const cutoff = Date.now() - 15_000;
  if (
    store.db
      .prepare(
        "SELECT 1 FROM runs WHERE heartbeat IS NOT NULL AND heartbeat>? LIMIT 1",
      )
      .get(cutoff)
  )
    throw new AgentError(
      "RUN_BUSY",
      "実行・適用・評価を停止してからバックアップしてください。",
    );
  const sessions = store.db
    .prepare(
      "SELECT id,owner,heartbeat FROM conversations WHERE owner IS NOT NULL AND heartbeat>?",
    )
    .all(cutoff);
  if (
    sessions.some(
      (row) =>
        !owner || row.id !== owner.sessionId || row.owner !== owner.owner,
    )
  )
    throw new AgentError(
      "SESSION_BUSY",
      "ほかのAgent画面を閉じてからバックアップしてください。",
    );
  if (
    owner &&
    !sessions.some(
      (row) => row.id === owner.sessionId && row.owner === owner.owner,
    )
  )
    throw new AgentError(
      "SESSION_BUSY",
      "現在の会話の所有権を確認できません。",
    );
}
function outputDirectory(store: Store, destination: string): string {
  const path = join(
    realpathSync(dirname(resolve(destination))),
    resolve(destination).split(/[\\/]/).at(-1)!,
  );
  directory(dirname(path));
  if (existsSync(path))
    throw new AgentError(
      "EXISTS",
      "保存先は存在しない新しいディレクトリを指定してください。",
    );
  const roots = [
    store.paths.home,
    ...store.db
      .prepare("SELECT DISTINCT workspace FROM conversations")
      .all()
      .map((row) => String(row.workspace)),
  ];
  for (const row of store.db.prepare("SELECT payload FROM runs").iterate()) {
    const run = JSON.parse(String(row.payload)) as { workspace?: string };
    if (run.workspace) roots.push(run.workspace);
  }
  for (const root of roots) {
    for (const location of new Set([
      resolve(root),
      ...(existsSync(root) ? [realpathSync(root)] : []),
    ]))
      if (within(location, path) || within(path, location))
        fail("Agent保存領域・作業ディレクトリの外を選んでください。");
  }
  return path;
}
function previewInTransaction(
  store: Store,
  config: Config,
  destination: string,
  limits: z.output<typeof limitsSchema>,
  owner?: BackupOwner,
): BackupPreview {
  assertQuiescent(store, owner);
  const deadline = Date.now() + limits.timeoutMs;
  const state = snapshotMetadata(store.db, deadline);
  const files = [
    ...state.references.values(),
    { path: "config.yaml" },
    ...(existsSync(join(store.paths.home, "terminal.json"))
      ? [{ path: "terminal.json" }]
      : []),
  ];
  let bytes =
    Number(store.db.prepare("PRAGMA page_count").get()!.page_count) *
    Number(store.db.prepare("PRAGMA page_size").get()!.page_size);
  for (const file of files) {
    deadlineCheck(deadline);
    const path = join(store.paths.home, file.path);
    parents(store.paths.home, path);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      !owned(stat) ||
      stat.mode & 0o022
    )
      fail("保存対象に安全でないファイルがあります。");
    if ("bytes" in file && stat.size !== file.bytes)
      fail("保存対象のサイズが参照と一致しません。");
    bytes += stat.size;
  }
  if (files.length + 1 > limits.maxFiles || bytes > limits.maxBytes)
    throw new AgentError(
      "BACKUP_LIMIT",
      "バックアップの件数・サイズ上限を超えています。",
    );
  const target = outputDirectory(store, destination);
  const settings = readSafe(
    store.paths.home,
    store.paths.config,
    Math.min(limits.maxBytes, 4_000_000),
  );
  if (
    configHash(
      validateConfig(parse(settings.toString(), { maxAliasCount: 0 })),
    ) !== configHash(config)
  )
    throw new AgentError(
      "CONFIG_CHANGED",
      "設定が変わりました。再読み込みしてください。",
    );
  const preferences = existsSync(join(store.paths.home, "terminal.json"))
    ? sha256(
        readSafe(
          store.paths.home,
          join(store.paths.home, "terminal.json"),
          32_000,
        ),
      )
    : undefined;
  return {
    destination: target,
    binding: sha256(
      canonical({
        state: state.binding,
        config: sha256(settings),
        preferences,
        destination: target,
        limits,
      }),
    ),
    configBytesHash: sha256(settings),
    preferencesBytesHash: preferences,
    files: files.length + 1,
    estimatedBytes: bytes,
    conversations: state.conversations,
    runs: state.runs,
    limits,
  };
}
export function previewBackup(
  store: Store,
  config: Config,
  destination: string,
  options: { limits?: BackupLimits; owner?: BackupOwner } = {},
): BackupPreview {
  const limits = limitsSchema.parse(options.limits);
  return store.transaction(() =>
    previewInTransaction(store, config, destination, limits, options.owner),
  );
}
function writePrivate(root: string, path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  parents(root, path);
  const fd = openSync(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export async function createBackup(
  store: Store,
  config: Config,
  preview: BackupPreview,
  options: {
    owner?: BackupOwner;
    signal?: AbortSignal;
    beforeCapture?: () => void;
  } = {},
): Promise<BackupManifest> {
  options.signal?.throwIfAborted();
  const limits = limitsSchema.parse(preview.limits);
  const release = await lockfile.lock(store.paths.config, {
    retries: 0,
    stale: limits.timeoutMs + 30_000,
  });
  let created: Stats | undefined;
  try {
    options.signal?.throwIfAborted();
    return store.transaction(() => {
      options.beforeCapture?.();
      const current = previewInTransaction(
        store,
        config,
        preview.destination,
        limits,
        options.owner,
      );
      if (current.binding !== preview.binding)
        throw new AgentError(
          "STALE_VIEW",
          "保存対象が変わりました。バックアップを選び直してください。",
        );
      const deadline = Date.now() + limits.timeoutMs;
      mkdirSync(current.destination, { mode: 0o700 });
      created = lstatSync(current.destination);
      const manifest: BackupManifest = {
        format: "local-agent-history-backup",
        version: 1,
        createdAt: Date.now(),
        configHash: configHash(config),
        scope: "committed-history-and-evidence",
        excluded: [...backupExclusions],
        files: [],
      };
      const database = join(current.destination, "metadata.sqlite");
      const reader = new DatabaseSync(store.paths.database, { readOnly: true });
      try {
        reader.exec(`VACUUM INTO '${database.replaceAll("'", "''")}'`);
      } finally {
        reader.close();
      }
      chmodSync(database, 0o600);
      const state = snapshotMetadata(store.db, deadline);
      const references: BlobReference[] = [
        { path: "config.yaml", sha256: current.configBytesHash },
        ...state.references.values(),
        ...(current.preferencesBytesHash
          ? [{ path: "terminal.json", sha256: current.preferencesBytesHash }]
          : []),
      ];
      let bytes = 0;
      const record = (
        path: string,
        file: { bytes: number; sha256: string },
      ) => {
        bytes += file.bytes;
        if (bytes > limits.maxBytes || manifest.files.length >= limits.maxFiles)
          throw new AgentError(
            "BACKUP_LIMIT",
            "バックアップのサイズ・件数上限を超えています。",
          );
        manifest.files.push({ path, ...file });
      };
      record(
        "metadata.sqlite",
        hashSafe(current.destination, database, limits.maxBytes, deadline),
      );
      const saved = new DatabaseSync(database, { readOnly: true });
      try {
        assertDatabase(saved);
        if (snapshotMetadata(saved, deadline).binding !== state.binding)
          fail("保存データベースが元の状態と一致しません。");
      } finally {
        saved.close();
      }
      for (const reference of references) {
        deadlineCheck(deadline);
        const data = readSafe(
          store.paths.home,
          join(store.paths.home, reference.path),
          Math.min(limits.maxBytes - bytes, 64_000_000),
        );
        if (
          (reference.bytes !== undefined && data.length !== reference.bytes) ||
          (reference.sha256 && sha256(data) !== reference.sha256)
        )
          fail("保存済み資料の内容が参照と一致しません。");
        const path = archivePath(reference.path);
        if (!safeArchivePath(path)) fail("保存対象のパスが不正です。");
        writePrivate(
          current.destination,
          join(current.destination, path),
          data,
        );
        record(path, { bytes: data.length, sha256: sha256(data) });
      }
      const savedConfig = manifest.files.find(
        (file) => file.path === "configuration.yaml",
      )!;
      if (
        sha256(readSafe(store.paths.home, store.paths.config, 4_000_000)) !==
        savedConfig.sha256
      )
        fail("保存中に設定が変化しました。");
      const currentConfig = validateConfig(
        parse(
          readSafe(
            current.destination,
            join(current.destination, "configuration.yaml"),
            4_000_000,
          ).toString(),
          { maxAliasCount: 0 },
        ),
      );
      if (configHash(currentConfig) !== manifest.configHash)
        fail("保存中に設定が変化しました。");
      const text = JSON.stringify(manifest, null, 2) + "\n";
      if (bytes + Buffer.byteLength(text) > limits.maxBytes)
        throw new AgentError(
          "BACKUP_LIMIT",
          "完了記録を含むサイズ上限を超えています。",
        );
      deadlineCheck(deadline);
      writePrivate(
        current.destination,
        join(current.destination, "backup.json"),
        text,
      );
      const fd = openSync(current.destination, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return manifest;
    });
  } catch (error) {
    if (created) {
      const now = lstatSync(preview.destination, { throwIfNoEntry: false });
      if (now && now.dev === created.dev && now.ino === created.ino)
        rmSync(preview.destination, { recursive: true });
    }
    throw error;
  } finally {
    await release();
  }
}

export function verifyBackup(
  path: string,
  options?: BackupLimits,
): BackupManifest {
  const limits = limitsSchema.parse(options),
    deadline = Date.now() + limits.timeoutMs;
  const root = realpathSync(path);
  directory(root);
  const manifestBytes = readSafe(
    root,
    join(root, "backup.json"),
    Math.min(limits.maxBytes, 32_000_000),
  );
  const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString()));
  if (manifest.files.length > limits.maxFiles)
    fail("保存件数が検査上限を超えています。");
  const entries = new Map<string, z.infer<typeof entrySchema>>();
  let bytes = manifestBytes.length;
  for (const entry of manifest.files) {
    deadlineCheck(deadline);
    if (!safeArchivePath(entry.path) || entries.has(entry.path))
      fail("バックアップの保存パスが不正・重複しています。");
    bytes += entry.bytes;
    if (bytes > limits.maxBytes) fail("保存サイズが検査上限を超えています。");
    const actual = hashSafe(
      root,
      join(root, entry.path),
      entry.bytes,
      deadline,
    );
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256)
      fail("バックアップの内容が一致しません。");
    entries.set(entry.path, entry);
  }
  for (const required of ["metadata.sqlite", "configuration.yaml"])
    if (!entries.has(required))
      fail("バックアップの必須ファイルがありません。");
  const config = validateConfig(
    parse(
      readSafe(root, join(root, "configuration.yaml"), 4_000_000).toString(),
      { maxAliasCount: 0 },
    ),
  );
  if (configHash(config) !== manifest.configHash)
    fail("設定の検証値が一致しません。");
  const database = new DatabaseSync(join(root, "metadata.sqlite"), {
    readOnly: true,
  });
  try {
    assertDatabase(database);
    for (const reference of snapshotMetadata(
      database,
      deadline,
    ).references.values()) {
      const entry = entries.get(archivePath(reference.path));
      if (
        !entry ||
        entry.bytes !== reference.bytes ||
        entry.sha256 !== reference.sha256
      )
        fail("保存済み資料の参照先が不足・不一致です。");
    }
  } finally {
    database.close();
  }
  deadlineCheck(deadline);
  return manifest;
}

function assertDatabase(database: DatabaseSync): void {
  const version = database.prepare("PRAGMA user_version").get()!.user_version;
  const hasDeletionQueue = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='deletion_queue'",
    )
    .get();
  if (
    (version !== 3 && version !== 4) ||
    (version === 4 && !hasDeletionQueue) ||
    Object.values(database.prepare("PRAGMA quick_check").get()!)[0] !== "ok" ||
    database.prepare("PRAGMA foreign_key_check").get()
  )
    fail("保存データベースの整合性を確認できません。");
}
