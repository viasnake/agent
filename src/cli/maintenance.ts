import type { CliContext } from "./context.js";
import { paths as agentPaths } from "../config.js";
import {
  diagnosticWarning,
  previewDiagnostics,
  writeDiagnostics,
} from "../diagnostics.js";
import {
  backupExclusions,
  createBackup,
  previewBackup,
  verifyBackup,
  type BackupLimits,
} from "../backup.js";
import {
  backupReadWarning,
  extractBackupFile,
  previewBackupExtract,
  readBackup,
  type BackupSelection,
} from "../backup-reader.js";
import {
  confirmHistoryDeletion,
  pendingDeletions,
  previewHistoryDeletion,
  retryDeletionCleanup,
} from "../history-deletion.js";
import {
  confirmCacheCleanup,
  pendingCacheCleanups,
  previewCacheCleanup,
  previewCacheCleanupJob,
} from "../cache-cleanup.js";

const deletionWarning =
  "メタデータを先に削除する限定的な処理です。共有画像・文書・checkpoint は残り、SQLite の残存ページや外部バックアップにも内容が残る場合があります。物理削除は保留になることがあり、自動再試行や暗号学的消去は行いません。";
function readLimits(options: {
  maxBytes?: number;
  maxFiles?: number;
  timeoutSeconds?: number;
}): BackupLimits {
  return {
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
    timeoutMs:
      options.timeoutSeconds === undefined
        ? undefined
        : options.timeoutSeconds * 1000,
  };
}
export function registerMaintenanceCommands(cli: CliContext): void {
  const { program, print, context, signal } = cli;
  program
    .command("backup-read <directory>")
    .description(
      "Read verified archived history offline without importing or resuming it",
    )
    .option(
      "--section <kind>",
      "conversations, runs, or files",
      "conversations",
    )
    .option("--conversation <id>", "list saved messages in one conversation")
    .option("--message <number>", "read a message in --conversation", Number)
    .option("--run <id>", "list saved artifacts and linked sources")
    .option(
      "--file <path>",
      "read a manifest path as UTF-8, or show binary metadata",
    )
    .option(
      "--offset <number>",
      "row offset, or UTF-16 offset for text pages",
      Number,
      0,
    )
    .option("--max-bytes <number>", "total archive size limit", Number)
    .option("--max-files <number>", "archive file limit", Number)
    .option("--timeout-seconds <number>", "verification time budget", Number)
    .action((directory: string, options) => {
      const selected = [options.conversation, options.run, options.file].filter(
        (value) => value !== undefined,
      );
      if (
        selected.length > 1 ||
        (options.message !== undefined && !options.conversation) ||
        (selected.length && options.section !== "conversations")
      )
        throw new Error(
          "表示対象は一つだけ指定してください。--message には --conversation が必要です。",
        );
      let selection: BackupSelection;
      if (options.conversation)
        selection =
          options.message === undefined
            ? { kind: "conversation", id: options.conversation }
            : {
                kind: "message",
                id: options.conversation,
                seq: options.message,
              };
      else if (options.run) selection = { kind: "run", id: options.run };
      else if (options.file) selection = { kind: "file", path: options.file };
      else {
        if (!["conversations", "runs", "files"].includes(options.section))
          throw new Error(
            "--section は conversations / runs / files から選んでください。",
          );
        selection = { kind: options.section };
      }
      print(
        readBackup(
          directory,
          { ...selection, offset: options.offset },
          readLimits(options),
        ),
      );
    });
  program
    .command("backup-extract <directory> <archive-path> <destination>")
    .description(
      "Preview export of one verified archived file; --write creates a private new file",
    )
    .option(
      "--write",
      "explicitly save the selected bytes without overwriting or importing",
    )
    .option("--max-bytes <number>", "total archive size limit", Number)
    .option("--max-files <number>", "archive file limit", Number)
    .option("--timeout-seconds <number>", "verification time budget", Number)
    .action((directory: string, path: string, destination: string, options) => {
      const protectedRoots = [
        agentPaths(program.opts().home).home,
        process.cwd(),
      ];
      const limits = readLimits(options);
      const preview = previewBackupExtract(
        directory,
        path,
        destination,
        protectedRoots,
        limits,
      );
      if (options.write) extractBackupFile(preview, protectedRoots, limits);
      print({
        ...preview,
        written: !!options.write,
        warning: backupReadWarning,
      });
    });
  program
    .command("diagnostics [file]")
    .description(
      "Preview allowlisted diagnostics without credentials, content or probes",
    )
    .option("--write", "save the preview to a new private file; never upload")
    .action(async (file: string | undefined, options) => {
      const paths = agentPaths(program.opts().home);
      const preview = await previewDiagnostics(paths);
      if (options.write) {
        if (!file)
          throw new Error("保存先の新しいファイル名を指定してください。");
        writeDiagnostics(paths, preview, file);
      }
      print({
        written: !!options.write,
        warning: diagnosticWarning,
        report: JSON.parse(preview.text),
      });
    });
  program
    .command("prune-cache [paths...]")
    .description(
      "Preview shared cache cleanup; --write explicitly removes selected blobs",
    )
    .option("--write", "explicitly confirm cleanup")
    .action((paths: string[], options) =>
      context(async (config, _p, store) => {
        const preview = await previewCacheCleanup(store, config, {
          kind: paths.length ? "selection" : "eligible",
          paths,
        });
        if (!options.write) {
          print({
            ...preview,
            written: false,
            warning:
              "24時間未満・参照中・稼働中プロセスの保持物は削除しません。暗号学的消去は保証しません。",
          });
          return;
        }
        const result = await confirmCacheCleanup(
          store,
          config,
          preview,
          signal,
        );
        print({
          written: true,
          ...result,
          cleanupComplete: result.pending.length === 0,
          warning:
            "共有キャッシュを削除します。バックアップ・SQLite残存ページは対象外で、暗号学的消去は保証しません。",
        });
      }),
    );
  program
    .command("cleanup-cache [job-id]")
    .description("List or explicitly retry one shared cache cleanup job")
    .option("--write", "retry the selected job")
    .action((jobId: string | undefined, options) =>
      context(async (config, _p, store) => {
        if (!jobId) {
          print({
            written: false,
            jobs: await pendingCacheCleanups(store.paths),
          });
          return;
        }
        if (!options.write) {
          print({
            written: false,
            preview: await previewCacheCleanupJob(store, config, jobId),
          });
          return;
        }
        const preview = await previewCacheCleanupJob(store, config, jobId);
        const result = await confirmCacheCleanup(
          store,
          config,
          preview,
          signal,
        );
        print({
          written: true,
          ...result,
          cleanupComplete: result.pending.length === 0,
          warning:
            "共有キャッシュの pending が残る場合、物理削除は完了していません。暗号学的消去は保証しません。",
        });
      }),
    );
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
    .description("Preview deletion of a terminal run and its owned history")
    .option("--write", "explicitly confirm the deletion")
    .action((runId: string, options) =>
      context(async (config, _p, store) => {
        const preview = previewHistoryDeletion(
          store,
          config,
          {
            kind: "selection",
            conversationIds: [],
            runIds: [runId],
          },
          { signal },
        );
        if (!options.write) {
          print({
            ...preview,
            written: false,
            warning: `${deletionWarning} --write で明示削除します。`,
          });
          return;
        }
        const result = await confirmHistoryDeletion(store, config, preview, {
          signal,
        });
        print({
          written: true,
          metadataRemoved: true,
          cleanupComplete: result.pendingCleanup.length === 0,
          ...result,
          warning: deletionWarning,
        });
      }),
    );
  program
    .command("remove-session <session-ids...>")
    .description(
      "Preview deletion of inactive conversations and their terminal runs",
    )
    .option("--write", "explicitly confirm the deletion")
    .action((sessionIds: string[], options) =>
      context(async (config, _p, store) => {
        const preview = previewHistoryDeletion(
          store,
          config,
          {
            kind: "selection",
            conversationIds: sessionIds,
            runIds: [],
          },
          { signal },
        );
        if (!options.write) {
          print({
            ...preview,
            written: false,
            warning: `${deletionWarning} --write で明示削除します。`,
          });
          return;
        }
        const result = await confirmHistoryDeletion(store, config, preview, {
          signal,
        });
        print({
          written: true,
          metadataRemoved: true,
          cleanupComplete: result.pendingCleanup.length === 0,
          ...result,
          warning: `${deletionWarning} cleanup-deletions --write <job-id> で明示retryします。`,
        });
      }),
    );
  program
    .command("prune")
    .description("Preview retention deletion older than retentionDays")
    .option("--dry-run", "list matching runs without deleting them")
    .option("--write", "explicitly confirm the deletion")
    .action((options) =>
      context(async (config, _p, store) => {
        if (options.dryRun && options.write)
          throw new Error("--dry-run and --write cannot be combined");
        const cutoff = Date.now() - config.retentionDays * 86400000;
        const preview = previewHistoryDeletion(
          store,
          config,
          { kind: "retention", cutoff },
          { signal },
        );
        if (!options.write) {
          print({
            ...preview,
            dryRun: !!options.dryRun,
            written: false,
            retentionDays: config.retentionDays,
            warning: `${deletionWarning} --write で明示削除します。`,
          });
          return;
        }
        const result = await confirmHistoryDeletion(store, config, preview, {
          signal,
        });
        print({
          written: true,
          metadataRemoved: true,
          cleanupComplete: result.pendingCleanup.length === 0,
          retentionDays: config.retentionDays,
          ...result,
          warning: `自動retentionではありません。${deletionWarning}`,
        });
      }),
    );
  program
    .command("cleanup-deletions [job-ids...]")
    .description(
      "List pending deletion cleanup jobs or explicitly retry selected jobs",
    )
    .option("--write", "retry only the listed cleanup job IDs")
    .action((jobIds: string[], options) =>
      context(async (_config, _p, store) => {
        if (options.write && !jobIds.length)
          throw new Error("--write requires at least one cleanup job ID");
        const jobs = options.write
          ? await retryDeletionCleanup(store, jobIds, { signal })
          : pendingDeletions(store);
        print({
          written: !!options.write,
          jobs,
          warning: `${deletionWarning} pending job 以外は対象外です。`,
        });
      }),
    );
}
