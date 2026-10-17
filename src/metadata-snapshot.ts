import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AgentError } from "./types.js";
import { canonical, sha256 } from "./util.js";

export const metadataTables = [
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
const maxRows = 100_000;
const maxBytes = 64_000_000;
const maxDepth = 100;

export interface MetadataBlobReference {
  path: string;
  sha256: string;
  bytes: number;
}
export interface MetadataSnapshot {
  binding: string;
  references: Map<string, MetadataBlobReference>;
  referencedDigests: Set<string>;
  conversations: number;
  runs: number;
  rows: number;
  bytes: number;
}

function fail(message: string): never {
  throw new AgentError("BACKUP_UNSAFE", message);
}
function check(deadline: number): void {
  if (Date.now() >= deadline)
    throw new AgentError(
      "BACKUP_LIMIT",
      "保存済みメタデータの処理時間上限を超えました。",
    );
}
function tableExists(db: DatabaseSync, table: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
}

export function snapshotMetadata(
  db: DatabaseSync,
  deadline: number,
): MetadataSnapshot {
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );
  if (version !== 3 && version !== 4) fail("未知のメタデータ schema です。");
  const hash = createHash("sha256");
  const references = new Map<string, MetadataBlobReference>();
  const referencedDigests = new Set<string>();
  let rows = 0;
  let bytes = 0;
  let conversations = 0;
  let runs = 0;
  let inputNodes = 0;
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
    references.set(path, {
      path,
      sha256: expectedHash,
      bytes: expectedBytes,
    });
  };
  const inputs = (value: unknown, depth = 0): void => {
    check(deadline);
    if (++inputNodes > 1_000_000)
      fail("保存済み資料の参照件数が上限を超えています。");
    if (depth > maxDepth) fail("保存済みメタデータの入れ子が深すぎます。");
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
  for (const table of metadataTables) {
    const optionalQueue = table === "deletion_queue";
    if (!tableExists(db, table)) {
      if (optionalQueue && version < 4) continue;
      fail(`必要なメタデータ table がありません: ${table}`);
    }
    hash.update(table);
    for (const raw of db
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .iterate()) {
      check(deadline);
      if (++rows > maxRows)
        fail("保存済みメタデータが件数上限を超えています。");
      const row = { ...raw } as Record<string, unknown>;
      if (table === "runs" || table === "conversations") delete row.heartbeat;
      if (table === "conversations") {
        delete row.updated_at;
        conversations++;
      }
      if (table === "runs") runs++;
      const encoded = canonical(row);
      bytes += Buffer.byteLength(encoded);
      if (bytes > maxBytes)
        fail("保存済みメタデータがサイズ上限を超えています。");
      hash.update(encoded + "\n");
      for (const match of encoded.matchAll(/[a-f0-9]{64}/g))
        referencedDigests.add(match[0]);
      if (typeof row.payload !== "string") continue;
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        fail("保存済みメタデータの JSON が不正です。");
      }
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
          for (const item of [
            ...(tree?.baseline ?? []),
            ...(tree?.work ?? []),
          ]) {
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
  return {
    binding: hash.digest("hex"),
    references,
    referencedDigests,
    conversations,
    runs,
    rows,
    bytes,
  };
}
