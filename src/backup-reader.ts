import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  readBackupEntry,
  withVerifiedBackup,
  type BackupLimits,
  type BackupManifest,
} from "./backup.js";
import { AgentError } from "./types.js";
import { canonical, sha256, within } from "./util.js";

export const backupReadWarning =
  "非公開の履歴です。過去の除外済み資料や手入力した秘密も含みます。表示・書出だけを行い、現在の会話・設定への取込、通信、実行、削除処理、再開は行いません。ハッシュは署名や内容の正しさを保証しません。";
const pageSize = 30;
const textPageSize = 16_000;
const offsetSchema = z.number().int().min(0).max(64_000_000);
const idSchema = z.uuid();
export type BackupSelection =
  | { kind: "conversations" | "runs" | "files"; offset?: number }
  | { kind: "conversation" | "run"; id: string; offset?: number }
  | { kind: "message"; id: string; seq: number; offset?: number }
  | { kind: "file"; path: string; offset?: number };
export interface BackupPage {
  kind: BackupSelection["kind"];
  createdAt: number;
  binding: string;
  warning: string;
  offset: number;
  nextOffset?: number;
  items: Record<string, unknown>[];
  detail?: Record<string, unknown>;
  text?: string;
}

function fail(message: string): never {
  throw new AgentError("BACKUP_UNSAFE", message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("保存済みメタデータの形式が不正です。");
  return value as Record<string, unknown>;
}
function payload(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") fail("保存済み本文が不正です。");
  return object(JSON.parse(value));
}
function short(value: unknown, limit = 500): string | undefined {
  return typeof value === "string" ? value.slice(0, limit) : undefined;
}
function textPage(page: BackupPage, text: string): void {
  let start = Math.min(page.offset, text.length);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(start))) start--;
  let end = Math.min(start + textPageSize, text.length);
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text.charAt(end))) end--;
  page.offset = start;
  page.text = text.slice(start, end);
  page.detail = { ...page.detail, textLength: text.length, unit: "UTF-16" };
  if (end < text.length) page.nextOffset = end;
}
function rowsPage(
  page: BackupPage,
  rows: Record<string, unknown>[],
  project: (row: Record<string, unknown>) => Record<string, unknown>,
): void {
  page.items = rows.slice(0, pageSize).map(project);
  if (rows.length > pageSize) page.nextOffset = page.offset + pageSize;
}
function requireRecord(
  database: DatabaseSync,
  kind: "conversation" | "run",
  id: string,
): Record<string, unknown> {
  idSchema.parse(id);
  const row = database
    .prepare(
      kind === "conversation"
        ? "SELECT payload FROM conversations WHERE id=?"
        : "SELECT payload FROM runs WHERE id=?",
    )
    .get(id);
  if (!row) fail("保存された会話・実行が見つかりません。");
  return payload(row.payload);
}

export function readBackup(
  path: string,
  selection: BackupSelection = { kind: "conversations" },
  limits?: BackupLimits,
): BackupPage {
  const offset = offsetSchema.parse(selection.offset ?? 0);
  return withVerifiedBackup(
    path,
    (root, manifest, database) => {
      const page: BackupPage = {
        kind: selection.kind,
        createdAt: manifest.createdAt,
        binding: sha256(canonical(manifest)),
        warning: backupReadWarning,
        offset,
        items: [],
      };
      switch (selection.kind) {
        case "conversations":
          rowsPage(
            page,
            database
              .prepare(
                "SELECT id,workspace,updated_at,payload FROM conversations ORDER BY updated_at DESC,id LIMIT ? OFFSET ?",
              )
              .all(pageSize + 1, offset),
            (row) => {
              const value = payload(row.payload);
              return {
                id: row.id,
                name: short(value.name),
                workspace: short(row.workspace, 4096),
                updatedAt: row.updated_at,
                dataClass: value.dataClass,
                localOnly: value.localOnly,
              };
            },
          );
          break;
        case "runs":
          rowsPage(
            page,
            database
              .prepare(
                "SELECT id,state,payload FROM runs ORDER BY rowid LIMIT ? OFFSET ?",
              )
              .all(pageSize + 1, offset),
            (row) => {
              const value = payload(row.payload);
              return {
                id: row.id,
                state: row.state,
                objective: short(value.objective),
                dataClass: value.dataClass,
                localOnly: value.localOnly,
              };
            },
          );
          break;
        case "conversation": {
          const value = requireRecord(database, "conversation", selection.id);
          page.detail = {
            id: selection.id,
            name: short(value.name),
            dataClass: value.dataClass,
            localOnly: value.localOnly,
          };
          rowsPage(
            page,
            database
              .prepare(
                "SELECT seq,role,text,run_id,at FROM messages WHERE session_id=? ORDER BY seq LIMIT ? OFFSET ?",
              )
              .all(selection.id, pageSize + 1, offset),
            (row) => ({
              seq: row.seq,
              role: row.role,
              at: row.at,
              runId: row.run_id,
              preview: short(row.text),
              textLength:
                typeof row.text === "string" ? row.text.length : undefined,
            }),
          );
          break;
        }
        case "message": {
          requireRecord(database, "conversation", selection.id);
          z.number().int().positive().safe().parse(selection.seq);
          const row = database
            .prepare(
              "SELECT seq,role,text,run_id,at FROM messages WHERE session_id=? AND seq=?",
            )
            .get(selection.id, selection.seq);
          if (!row || typeof row.text !== "string")
            fail("保存された発言が見つかりません。");
          page.detail = {
            conversationId: selection.id,
            seq: row.seq,
            role: row.role,
            at: row.at,
            runId: row.run_id,
          };
          textPage(page, row.text);
          break;
        }
        case "run": {
          const value = requireRecord(database, "run", selection.id);
          page.detail = {
            id: selection.id,
            objective: short(value.objective),
            state: value.state,
            dataClass: value.dataClass,
            localOnly: value.localOnly,
          };
          rowsPage(
            page,
            database
              .prepare(
                "SELECT payload FROM artifacts WHERE run_id=? OR id IN (SELECT artifact_id FROM source_links WHERE run_id=?) ORDER BY rowid LIMIT ? OFFSET ?",
              )
              .all(selection.id, selection.id, pageSize + 1, offset),
            (row) => {
              const artifact = payload(row.payload);
              return {
                id: artifact.id,
                name: short(artifact.name),
                kind: artifact.kind,
                runId: artifact.runId,
                dataClass: artifact.dataClass,
                bytes: artifact.bytes,
                sha256: artifact.sha256,
                path: `files/runs/${String(artifact.runId)}/artifacts/${String(artifact.sha256)}`,
              };
            },
          );
          break;
        }
        case "files":
          rowsPage(
            page,
            manifest.files.slice(offset, offset + pageSize + 1),
            (entry) => entry,
          );
          break;
        case "file": {
          const data = readBackupEntry(root, manifest, selection.path);
          page.detail = {
            ...manifest.files.find((file) => file.path === selection.path)!,
          };
          try {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
            if (text.includes("\0")) throw new Error("binary");
            page.detail.encoding = "UTF-8";
            textPage(page, text);
          } catch {
            page.detail.encoding = "binary";
          }
          break;
        }
      }
      return page;
    },
    limits,
  );
}

export interface BackupExtractPreview {
  archive: string;
  archiveBinding: string;
  parentBinding: string;
  path: string;
  destination: string;
  bytes: number;
  sha256: string;
  binding: string;
}
function safeParent(path: string): Stats {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid && stat.uid !== process.getuid()) ||
    stat.mode & 0o022
  )
    fail("所有する書込保護済みディレクトリを指定してください。");
  return stat;
}
function sameParent(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.uid === after.uid &&
    before.mode === after.mode
  );
}
function parentBinding(parent: Stats): string {
  return sha256(
    canonical({
      dev: parent.dev,
      ino: parent.ino,
      uid: parent.uid,
      mode: parent.mode,
    }),
  );
}
function extractionPreview(
  root: string,
  manifest: BackupManifest,
  database: DatabaseSync,
  path: string,
  destination: string,
  protectedRoots: string[],
): BackupExtractPreview {
  const entry = manifest.files.find((file) => file.path === path);
  if (!entry) fail("保存ファイルがありません。");
  const target = join(
    realpathSync(dirname(resolve(destination))),
    resolve(destination).split(/[\\/]/).at(-1)!,
  );
  const parent = safeParent(dirname(target));
  if (lstatSync(target, { throwIfNoEntry: false }))
    fail("書出先には存在しない新しいファイル名が必要です。");
  const roots = [
    root,
    ...protectedRoots,
    ...database
      .prepare("SELECT DISTINCT workspace FROM conversations")
      .all()
      .map((row) => row.workspace),
    ...database
      .prepare("SELECT payload FROM runs")
      .all()
      .map((row) => payload(row.payload).workspace),
  ].filter((value) => value !== undefined);
  const normalized = new Set<string>();
  for (const value of roots) {
    if (typeof value !== "string" || !isAbsolute(value))
      fail("保護対象の保存パスが不正です。");
    normalized.add(resolve(value));
    if (existsSync(value)) normalized.add(realpathSync(value));
  }
  for (const location of normalized)
    if (within(location, target) || within(target, location))
      fail("アーカイブ・Agent保存領域・元の作業領域の外を選んでください。");
  return {
    archive: root,
    archiveBinding: sha256(canonical(manifest)),
    parentBinding: parentBinding(parent),
    path,
    destination: target,
    bytes: entry.bytes,
    sha256: entry.sha256,
    binding: sha256(
      canonical({
        manifest,
        path,
        target,
        roots: [...normalized].sort(),
        parentBinding: parentBinding(parent),
      }),
    ),
  };
}

export function previewBackupExtract(
  archive: string,
  path: string,
  destination: string,
  protectedRoots: string[],
  limits?: BackupLimits,
): BackupExtractPreview {
  return withVerifiedBackup(
    archive,
    (root, manifest, database) =>
      extractionPreview(
        root,
        manifest,
        database,
        path,
        destination,
        protectedRoots,
      ),
    limits,
  );
}

export function extractBackupFile(
  preview: BackupExtractPreview,
  protectedRoots: string[],
  limits?: BackupLimits,
): void {
  withVerifiedBackup(
    preview.archive,
    (root, manifest, database) => {
      const current = extractionPreview(
        root,
        manifest,
        database,
        preview.path,
        preview.destination,
        protectedRoots,
      );
      if (current.binding !== preview.binding)
        throw new AgentError(
          "STALE_VIEW",
          "書出対象が変わりました。選び直してください。",
        );
      const data = readBackupEntry(root, manifest, current.path);
      const parent = safeParent(dirname(current.destination));
      if (parentBinding(parent) !== current.parentBinding)
        fail("保存先が変化しました。");
      const fd = openSync(current.destination, "wx", 0o600);
      const created = fstatSync(fd);
      try {
        if (!sameParent(parent, safeParent(dirname(current.destination))))
          fail("保存先が変化しました。");
        writeFileSync(fd, data);
        fsyncSync(fd);
        const directoryFd = openSync(dirname(current.destination), "r");
        try {
          fsyncSync(directoryFd);
        } finally {
          closeSync(directoryFd);
        }
        const saved = lstatSync(current.destination);
        if (
          !sameParent(parent, safeParent(dirname(current.destination))) ||
          saved.dev !== created.dev ||
          saved.ino !== created.ino ||
          saved.nlink !== 1 ||
          saved.size !== data.length ||
          saved.mode & 0o077
        )
          fail("保存先が変化しました。");
      } catch (error) {
        const now = lstatSync(current.destination, { throwIfNoEntry: false });
        if (now && now.dev === created.dev && now.ino === created.ino)
          rmSync(current.destination);
        throw error;
      } finally {
        closeSync(fd);
      }
    },
    limits,
  );
}
