#!/usr/bin/env node
import { Command } from "commander";
import { errorMessage, terminalText } from "./util.js";
process.umask(0o077);
const program = new Command()
  .name("agent")
  .description("対話型 Coding Agent — 引数なしで会話を開始")
  .version("0.1.0")
  .option("--home <directory>", "private configuration and state directory")
  .option("--json", "machine-readable compatibility output");

// Keep the interactive entry point independent of heavyweight provider imports.
// Existing commands remain for migration and automation compatibility.
const args = process.argv
  .slice(2)
  .filter(
    (arg, index, all) =>
      arg !== "--home" &&
      all[index - 1] !== "--home" &&
      !arg.startsWith("--home="),
  );
const interactive = !args.length;
try {
  if (interactive) {
    program.action(async () => {
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error(
          "agent は対話端末が必要です。端末から agent を起動してください。",
        );
      const { startTerminal } = await import("./tui/app.js");
      await startTerminal(program.opts().home);
    });
  } else {
    const abort = new AbortController();
    process.once("SIGINT", () => abort.abort());
    process.once("SIGTERM", () => abort.abort());
    const { createCliContext } = await import("./cli/context.js");
    const cli = createCliContext(program, abort.signal);
    const modules = await Promise.all([
      import("./cli/setup.js"),
      import("./cli/connections.js"),
      import("./cli/runs.js"),
      import("./cli/artifacts.js"),
      import("./cli/maintenance.js"),
      import("./cli/integrations.js"),
      import("./cli/environments.js"),
    ]);
    modules[0].registerSetupCommands(cli);
    modules[1].registerConnectionsCommands(cli);
    modules[2].registerRunsCommands(cli);
    modules[3].registerArtifactsCommands(cli);
    modules[4].registerMaintenanceCommands(cli);
    modules[5].registerIntegrationsCommands(cli);
    modules[6].registerEnvironmentCommands(cli);
  }
  await program.parseAsync();
} catch (error) {
  process.stderr.write(terminalText(errorMessage(error)) + "\n");
  process.exitCode = 1;
}
