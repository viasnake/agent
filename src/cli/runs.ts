import { Option } from "commander";
import type { CliContext } from "./context.js";
export function registerRunsCommands(cli: CliContext): void {
  const {
    program,
    signal,
    collect,
    print,
    progress,
    context,
    harness,
    status,
    exitForRun,
  } = cli;
  program
    .command("run")
    .argument("<objective>", "what you want to accomplish")
    .addOption(
      new Option("--mode <kind>", "workflow")
        .choices(["coding", "research", "writing"])
        .default("writing"),
    )
    .addOption(
      new Option("--strategy <mode>", "agent collaboration").choices([
        "single",
        "assisted",
        "reviewed",
      ]),
    )
    .addOption(
      new Option(
        "--data-class <class>",
        "input and derived-output classification",
      ).choices(["public", "private", "restricted"]),
    )
    .option("--workspace <path>", "source Git repository")
    .option("--include-untracked", "include non-ignored untracked files")
    .option(
      "--input <file>",
      "input document, or skill:workspace-relative/SKILL.md (repeatable)",
      collect,
      [],
    )
    .option("--check <id>", "trusted required check (repeatable)", collect, [])
    .option(
      "--preserve <literal>",
      "exact text required in output (repeatable)",
      collect,
      [],
    )
    .option("--model <alias>", "explicit worker or lead model")
    .option("--reviewer <alias>", "independent reviewer model")
    .option("--local-only", "forbid every external model/tool connection")
    .option("--prepare-only", "snapshot the request without making model calls")
    .action((objective: string, options) =>
      context(async (config, p, store) => {
        const runner = harness(config, p, store),
          run = await runner.create({
            objective,
            kind: options.mode,
            mode: options.strategy,
            dataClass: options.dataClass,
            workspace: options.workspace,
            includeUntracked: options.includeUntracked,
            inputs: options.input,
            checks: options.check,
            mustKeep: options.preserve,
            model: options.model,
            reviewer: options.reviewer,
            localOnly: options.localOnly,
          });
        progress("run_created", { runId: run.id });
        if (options.prepareOnly) {
          status(store, run);
          return;
        }
        const result = await runner.execute(run.id, signal);
        status(store, result);
        exitForRun(result);
      }),
    );
  program
    .command("resume <run-id>")
    .option("--input <text>", "additional user requirements while waiting")
    .action((runId: string, options) =>
      context(async (config, p, store) => {
        const result = await harness(config, p, store).execute(
          runId,
          signal,
          options.input,
        );
        status(store, result);
        exitForRun(result);
      }),
    );
  program
    .command("status [run-id]")
    .description("Show a run, or the 100 most recent runs")
    .action((runId?: string) =>
      context(async (_config, _p, store) => {
        if (runId) status(store, store.get(runId));
        else
          print(
            store.list().map((r) => ({
              id: r.id,
              state: r.state,
              kind: r.kind,
              objective: r.objective,
              createdAt: new Date(r.createdAt).toISOString(),
            })),
          );
      }),
    );
  program
    .command("events <run-id>")
    .option("--after <sequence>", "start after this event", "0")
    .action((runId: string, options) =>
      context(async (_config, _p, store) =>
        print(store.events(runId, Number(options.after))),
      ),
    );
  program
    .command("cancel <run-id>")
    .description(
      "Request cancellation; the execution process stops at once and records its state",
    )
    .action((runId: string) =>
      context(async (_config, _p, store) => {
        store.cancel(runId);
        print({ runId, cancelRequested: true });
      }),
    );
  program
    .command("reconcile <run-id> <operation-id>")
    .description("Record a manually verified outcome of an uncertain operation")
    .addOption(
      new Option("--outcome <status>")
        .choices(["completed", "failed"])
        .makeOptionMandatory(),
    )
    .requiredOption("--note <evidence>", "what you checked")
    .action((runId: string, operationId: string, options) =>
      context(async (_config, _p, store) => {
        const run = store.claim(runId, true);
        try {
          store.reconcile(run, operationId, options.outcome, options.note);
          print({ runId, operationId, outcome: options.outcome });
        } finally {
          store.release(run);
        }
      }),
    );
}
