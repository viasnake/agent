import { Option } from "commander";
import { FirecrackerEnvironment } from "../execution/firecracker.js";
import type { EnvironmentCommand } from "../execution/types.js";
import type { CliContext } from "./context.js";

export function registerEnvironmentCommands(cli: CliContext): void {
  const { program, signal, print } = cli;
  const environment = program
    .command("environment")
    .alias("env")
    .description("Manage a dedicated Firecracker agent environment");

  environment
    .command("doctor")
    .description(
      "Check the fixed Firecracker installation and host prerequisites",
    )
    .action(async () => {
      const result = await new FirecrackerEnvironment().diagnose(signal);
      print(result);
      if (!result.ok) process.exitCode = 1;
    });

  environment
    .command("create")
    .description(
      "Allocate a stopped environment with a private persistent disk",
    )
    .action(async () => {
      print(await new FirecrackerEnvironment().create(signal));
    });

  for (const [name, action] of [
    [
      "start",
      (env: FirecrackerEnvironment, id: string) => env.start(id, signal),
    ],
    [
      "status",
      (env: FirecrackerEnvironment, id: string) => env.status(id, signal),
    ],
    ["stop", (env: FirecrackerEnvironment, id: string) => env.stop(id, signal)],
    [
      "destroy",
      (env: FirecrackerEnvironment, id: string) => env.destroy(id, signal),
    ],
  ] as const) {
    environment
      .command(`${name} <id>`)
      .description(
        `${name.slice(0, 1).toUpperCase()}${name.slice(1)} a Firecracker environment`,
      )
      .action(async (id: string) => {
        const result = await action(new FirecrackerEnvironment(), id);
        print(result === undefined ? { id, destroyed: true } : result);
      });
  }

  environment
    .command("exec <id> <command...>")
    .description(
      "Execute argv directly in /workspace; this does not stop the VM",
    )
    .addOption(
      new Option("--timeout-ms <milliseconds>", "maximum command duration")
        .default(120000)
        .argParser((value) => Number(value)),
    )
    .addOption(
      new Option("--max-output-bytes <bytes>", "combined output limit")
        .default(65536)
        .argParser((value) => Number(value)),
    )
    .action(
      async (
        id: string,
        command: string[],
        options: { timeoutMs: number; maxOutputBytes: number },
      ) => {
        const request: EnvironmentCommand = {
          argv: command,
          timeoutMs: options.timeoutMs,
          maxOutputBytes: options.maxOutputBytes,
        };
        const result = await new FirecrackerEnvironment().execute(
          id,
          request,
          signal,
        );
        print(result);
        if (result.code !== 0)
          process.exitCode = result.code > 0 ? result.code : 1;
      },
    );
}
