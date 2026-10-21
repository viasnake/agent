import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import { validateConfig, type Config, type Paths } from "./config.js";
import { AgentError } from "./types.js";
import { readBoundedFile, within } from "./util.js";

const runStates = [
  "created",
  "planning",
  "running",
  "validating",
  "repairing",
  "waiting_input",
  "waiting_quota",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
] as const;
const operationStates = [
  "prepared",
  "dispatched",
  "completed",
  "failed",
  "unknown",
] as const;
const requestStates = ["reserved", "completed", "failed", "unknown"] as const;
const eventTypes = [
  "run_created",
  "run_claimed",
  "state_changed",
  "cancel_requested",
  "operation_prepared",
  "operation_dispatched",
  "operation_completed",
  "operation_failed",
  "operation_unknown",
  "operation_reconciled",
  "request_reserved",
  "request_completed",
  "artifact_saved",
  "context_usage",
  "task_started",
  "task_completed",
  "task_failed",
] as const;
const connectionTypes = [
  "chatgpt",
  "gemini",
  "sarashina",
  "compatible",
  "local",
  "clef",
] as const;
const sampleLimit = 1000;

export const diagnosticWarning =
  "共有用の限定診断です。本文・ID・パス・接続先・資格情報・自由文のエラーやログは含めません。バージョン・設定種別・件数は残るため、共有前に内容を確認してください。接続・隔離の試験や推論は実行せず、完全な匿名化・バックアップ・検証証拠ではありません。件数は最近挿入された最大1000行の標本で、総数ではありません。自動送信は行いません。";
export interface DiagnosticPreview {
  readonly text: string;
}
const previews = new WeakMap<
  DiagnosticPreview,
  { home: string; text: string }
>();

function owned(stat: ReturnType<typeof lstatSync>): boolean {
  return !!stat && (!process.getuid || stat.uid === process.getuid());
}
function canonicalLocation(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalLocation(parent), basename(path));
  }
}
function safeHome(paths: Paths): void {
  const stat = lstatSync(paths.home);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !owned(stat) ||
    stat.mode & 0o077
  )
    throw new Error("unsafe");
}
function bucket(value: string, allowed: readonly string[]): string {
  return allowed.includes(value) ? value : "other";
}
function histogram(values: string[], allowed: readonly string[]) {
  return [...allowed, "other"].map((category) => ({
    category,
    count: values.filter((value) => bucket(value, allowed) === category).length,
  }));
}
function categories(
  db: DatabaseSync,
  table: "runs" | "operations" | "requests" | "events",
  column: "state" | "status" | "type",
  allowed: readonly string[],
  limit: number,
) {
  // Only closed vocabularies leave SQLite; payload/detail/name columns are never read.
  const rows = db
    .prepare(
      `SELECT CASE WHEN ${column} IN (${allowed.map(() => "?").join(",")}) THEN ${column} ELSE 'other' END AS category FROM ${table} ORDER BY rowid DESC LIMIT ?`,
    )
    .all(...allowed, limit + 1) as Array<{ category: string }>;
  return {
    rows: rows.slice(0, limit).map((row) => bucket(row.category, allowed)),
    truncated: rows.length > limit,
  };
}
function storageReport(paths: Paths) {
  let db: DatabaseSync | undefined;
  try {
    safeHome(paths);
    if (resolve(paths.database) !== join(resolve(paths.home), "state.sqlite"))
      throw new Error("path");
    const stat = lstatSync(paths.database);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      !owned(stat) ||
      stat.mode & 0o077
    )
      throw new Error("unsafe");
    db = new DatabaseSync(paths.database, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;");
    const version = Number(
      db.prepare("PRAGMA user_version").get()!.user_version,
    );
    if (version !== 3 && version !== 4) throw new Error("schema");
    const runs = categories(db, "runs", "state", runStates, sampleLimit);
    const operations = categories(
      db,
      "operations",
      "status",
      operationStates,
      sampleLimit,
    );
    const requests = categories(
      db,
      "requests",
      "status",
      requestStates,
      sampleLimit,
    );
    const events = categories(db, "events", "type", eventTypes, 40);
    db.exec("COMMIT");
    return {
      status: "available",
      schemaVersion: version,
      selection: "recent-insertions-not-totals",
      sampleLimit,
      runs: {
        scanned: runs.rows.length,
        truncated: runs.truncated,
        counts: histogram(runs.rows, runStates),
      },
      operations: {
        scanned: operations.rows.length,
        truncated: operations.truncated,
        counts: histogram(operations.rows, operationStates),
      },
      requests: {
        scanned: requests.rows.length,
        truncated: requests.truncated,
        counts: histogram(requests.rows, requestStates),
      },
      events: {
        order: "oldest-to-newest-within-recent-window",
        truncated: events.truncated,
        categories: events.rows.reverse(),
      },
    };
  } catch {
    return { status: "unavailable" };
  } finally {
    try {
      db?.close();
    } catch {
      /* Never export database exception details. */
    }
  }
}
async function configuration(paths: Paths, input?: Config) {
  try {
    safeHome(paths);
    const config =
      input ??
      validateConfig(
        parse(
          (await readBoundedFile(paths.config, 4_000_000)).toString("utf8"),
          { maxAliasCount: 0 },
        ),
      );
    const types = Object.values(config.connections)
      .filter((connection) => connection.enabled)
      .map((connection) => connection.type);
    return {
      status: "available",
      backend: bucket(config.execution.backend, ["bubblewrap", "disabled"]),
      routing: bucket(config.routing.mode, ["rules", "shadow", "assisted"]),
      models: Object.keys(config.models).length,
      enabledConnections: histogram(types, connectionTypes),
      mcpServers: Object.keys(config.mcp).length,
      checks: Object.keys(config.checks).length,
    };
  } catch {
    return { status: "unavailable" };
  }
}
export async function previewDiagnostics(
  paths: Paths,
  config?: Config,
): Promise<DiagnosticPreview> {
  const nodeVersion = process.versions.node.split(".").map(Number);
  const report = {
    formatVersion: 1,
    applicationVersion: "0.1.0",
    probes: "not-run",
    runtime: {
      node:
        nodeVersion.length === 3 &&
        nodeVersion.every(
          (value) =>
            Number.isSafeInteger(value) && value >= 0 && value < 1_000_000,
        )
          ? nodeVersion
          : null,
      platform: bucket(process.platform, ["linux", "darwin"]),
      architecture: bucket(process.arch, ["x64", "arm64"]),
    },
    configuration: await configuration(paths, config),
    storage: storageReport(paths),
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  const preview = Object.freeze({ text });
  previews.set(preview, { home: resolve(paths.home), text });
  return preview;
}
export function writeDiagnostics(
  paths: Paths,
  preview: DiagnosticPreview,
  destination: string,
): void {
  const captured = previews.get(preview);
  if (
    !captured ||
    captured.home !== resolve(paths.home) ||
    captured.text !== preview.text
  )
    throw new AgentError(
      "DIAGNOSTIC_PREVIEW",
      "診断の確認内容が無効です。表示からやり直してください。",
    );
  let fd: number | undefined;
  let target: string | undefined;
  let created: ReturnType<typeof fstatSync> | undefined;
  try {
    const parent = realpathSync(dirname(resolve(destination)));
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || !owned(stat) || stat.mode & 0o022)
      throw new Error("parent");
    const home = canonicalLocation(resolve(paths.home));
    target = join(parent, basename(destination));
    if (within(home, target)) throw new Error("internal");
    fd = openSync(
      target,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = fstatSync(fd);
    const after = lstatSync(parent);
    if (stat.dev !== after.dev || stat.ino !== after.ino)
      throw new Error("changed");
    writeFileSync(fd, captured.text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const directory = openSync(
      parent,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    previews.delete(preview);
  } catch {
    if (fd !== undefined) closeSync(fd);
    if (target && created) {
      try {
        const current = lstatSync(target);
        if (current.dev === created.dev && current.ino === created.ino)
          unlinkSync(target);
      } catch {
        /* Preserve any replacement file. */
      }
    }
    throw new AgentError(
      "DIAGNOSTIC_WRITE",
      "診断を保存できません。Agent領域外の安全な既存ディレクトリと、未使用のファイル名を指定してください。",
    );
  }
}
