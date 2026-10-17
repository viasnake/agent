import type { CliContext } from "./context.js";
import {
  backupExclusions,
  createBackup,
  previewBackup,
  verifyBackup,
} from "../backup.js";
export function registerMaintenanceCommands(cli: CliContext): void {
  const { program, print, context, signal } = cli;
  program
    .command("backup <directory>")
    .description(
      "Preview a private history/evidence backup; never copies credentials or a runnable environment",
    )
    .option(
      "--write",
      "explicitly write the backup to a new directory (default: preview only)",
    )
    .option(
      "--max-bytes <number>",
      "total size limit, default 512000000",
      Number,
    )
    .option("--max-files <number>", "file limit, default 50000", Number)
    .option(
      "--timeout-seconds <number>",
      "time budget, default 30; checked between local operations",
      Number,
    )
    .action((directory: string, options) =>
      context(async (config, _p, store) => {
        const preview = previewBackup(store, config, directory, {
          limits: {
            maxBytes: options.maxBytes,
            maxFiles: options.maxFiles,
            timeoutMs:
              options.timeoutSeconds === undefined
                ? undefined
                : options.timeoutSeconds * 1000,
          },
        });
        if (!options.write) {
          print({
            ...preview,
            written: false,
            scope: "全作業ディレクトリの保存済み会話・出典・成果物・設定",
            excluded: backupExclusions,
            warning:
              "共有用の診断ではありません。本文・設定に手入力した秘密や過去の除外済み資料も含まれます。稼働環境の復元は対象外です。--write で明示保存します。",
          });
          return;
        }
        const manifest = await createBackup(store, config, preview, { signal });
        print({
          written: true,
          destination: preview.destination,
          files: manifest.files.length,
          scope: manifest.scope,
          excluded: manifest.excluded,
          warning:
            "非公開の履歴アーカイブです。実行環境の復元・再開は行いません。",
        });
      }),
    );
  program
    .command("backup-verify <directory>")
    .description(
      "Verify a local backup's hashes and reference completeness without restoring or executing it",
    )
    .option("--max-bytes <number>", "total size limit", Number)
    .option("--max-files <number>", "file limit", Number)
    .option("--timeout-seconds <number>", "time budget", Number)
    .action((directory: string, options) => {
      const manifest = verifyBackup(directory, {
        maxBytes: options.maxBytes,
        maxFiles: options.maxFiles,
        timeoutMs:
          options.timeoutSeconds === undefined
            ? undefined
            : options.timeoutSeconds * 1000,
      });
      print({
        valid: true,
        files: manifest.files.length,
        scope: manifest.scope,
        warning:
          "バイト列・参照の整合性検査です。署名・内容の正しさ・実行環境の復元を保証しません。",
      });
    });
  program
    .command("remove <run-id>")
    .description(
      "Delete a terminal run and its sessions, sources, artifacts and working copy",
    )
    .action((runId: string) =>
      context(async (_config, _p, store) => {
        await store.remove(runId);
        print({ removed: runId });
      }),
    );
  program
    .command("prune")
    .description(
      "Remove terminal runs older than retentionDays; credentials are retained",
    )
    .option("--dry-run", "list matching runs without deleting them")
    .action((options) =>
      context(async (config, _p, store) => {
        const cutoff = Date.now() - config.retentionDays * 86400000;
        const selected = store
          .list(null)
          .filter(
            (run) =>
              ["succeeded", "failed", "cancelled"].includes(run.state) &&
              run.updatedAt < cutoff,
          );
        if (!options.dryRun)
          for (const run of selected) await store.remove(run.id);
        print({
          dryRun: !!options.dryRun,
          retentionDays: config.retentionDays,
          runs: selected.map((r) => r.id),
        });
      }),
    );
}
