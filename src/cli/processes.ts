import {
  ManagedProcesses,
  provisionManagedProcessAnchor,
} from "../managed-processes.js";
import type { CliContext } from "./context.js";

export function registerProcessCommands(cli: CliContext): void {
  const { program, context, print } = cli;
  const process = program
    .command("process")
    .description("Manage bounded Podman processes");
  process.command("provision").action(() =>
    context(async (config) => {
      const anchor = await provisionManagedProcessAnchor(config);
      print({
        execution: {
          managedProcesses: {
            engineAnchor: anchor,
          },
        },
      });
    }),
  );
  process.command("list <run-id>").action((runId: string) =>
    context(async (config, _paths, store) => {
      print(await new ManagedProcesses(config, store, store.get(runId)).list());
    }),
  );
  process
    .command("status <run-id> <process-id>")
    .action((runId: string, processId: string) =>
      context(async (config, _paths, store) => {
        print(
          await new ManagedProcesses(config, store, store.get(runId)).status(
            processId,
          ),
        );
      }),
    );
  process
    .command("logs <run-id> <process-id>")
    .action((runId: string, processId: string) =>
      context(async (config, _paths, store) => {
        print(
          await new ManagedProcesses(config, store, store.get(runId)).logs(
            processId,
          ),
        );
      }),
    );
  process
    .command("stop <run-id> <process-id>")
    .action((runId: string, processId: string) =>
      context(async (config, _paths, store) => {
        const run = store.claim(runId, true, true);
        const heartbeat = setInterval(() => {
          try {
            store.heartbeatLease(run.id, run.generation);
          } catch {
            clearInterval(heartbeat);
          }
        }, 1000);
        heartbeat.unref();
        try {
          print(await new ManagedProcesses(config, store, run).stop(processId));
        } finally {
          clearInterval(heartbeat);
          store.release(run);
        }
      }),
    );
}
