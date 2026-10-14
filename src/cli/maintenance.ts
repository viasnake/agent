import type { CliContext } from "./context.js";
export function registerMaintenanceCommands(cli: CliContext): void {
  const { program, print, context } = cli;
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
