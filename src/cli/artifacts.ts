import { applyRun, exportArtifacts } from "../artifacts.js";
import { workspaceDiff } from "../workspace.js";
import type { CliContext } from "./context.js";
import { registerWritingCommands } from "./writing.js";
export function registerArtifactsCommands(cli: CliContext): void {
  registerWritingCommands(cli);
  const { program, print, context } = cli;
  program
    .command("artifacts <run-id>")
    .option(
      "--export <directory>",
      "export verified artifacts into a new/empty directory",
    )
    .action((runId: string, options) =>
      context(async (_config, p, store) => {
        const artifacts = options.export
          ? await exportArtifacts(store, p, runId, options.export)
          : store.artifacts(runId);
        print(artifacts);
      }),
    );
  program
    .command("diff <run-id>")
    .description("Print the current diff from the input snapshot")
    .action((runId: string) =>
      context(async (config, _p, store) =>
        print(
          await workspaceDiff(
            store.runDir(runId),
            config.limits.maxWorkspaceBytes,
          ),
        ),
      ),
    );
  program
    .command("apply <run-id>")
    .description(
      "Apply a successful, verified coding result to its unchanged source repository",
    )
    .option(
      "--dry-run",
      "verify all preconditions without writing source files",
    )
    .action((runId: string, options) =>
      context(async (config, _p, store) => {
        print(await applyRun(config, store, runId, options.dryRun));
      }),
    );
}
