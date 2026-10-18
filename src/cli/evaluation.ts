import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import {
  assessComparison,
  compareRuns,
  comparisonSchedule,
  comparisonSchema,
  comparisonSummary,
  readComparison,
} from "../evaluation.js";
import { AgentError } from "../types.js";
import { readText } from "../util.js";
import type { CliContext } from "./context.js";

export function registerComparisonCommands(cli: CliContext): void {
  const { program, context, print, harness, signal } = cli;
  program
    .command("eval-compare")
    .description(
      "Compare matched cases with equal per-run budgets; preview by default",
    )
    .requiredOption("--suite <file>", "Versioned JSON/YAML comparison suite")
    .option(
      "--prepare-only",
      "Show the exact schedule and budget without inference",
    )
    .option(
      "--confirm-run",
      "Authorize all scheduled model calls, consuming quota/budget",
    )
    .action((options) =>
      context(async (config, paths, store) => {
        if (options.confirmRun && options.prepareOnly)
          throw new AgentError(
            "INPUT",
            "Choose --prepare-only or --confirm-run, not both",
          );
        const file = resolve(options.suite);
        const suite = comparisonSchema.parse(
          parse(await readText(file, 2_000_000), { maxAliasCount: 0 }),
        );
        for (const entry of suite.cases) {
          if (entry.workspace)
            entry.workspace = resolve(dirname(file), entry.workspace);
          entry.inputs = entry.inputs.map((path) =>
            resolve(dirname(file), path),
          );
        }
        if (!options.confirmRun) {
          const schedule = comparisonSchedule(suite).map((item) => ({
            caseId: suite.cases[item.caseIndex]!.id,
            variantId: suite.variants[item.variantIndex]!.id,
            repeat: item.repeat,
          }));
          print({
            prepared: true,
            inferenceStarted: false,
            suite,
            schedule,
            perRun: {
              maxRequests: config.limits.maxRequests,
              maxApiUsd: config.limits.maxApiUsd,
              maxSeconds: config.limits.maxSeconds,
            },
            configuredMaximum: {
              requests: schedule.length * config.limits.maxRequests,
              apiUsd: schedule.length * config.limits.maxApiUsd,
            },
            notice:
              "This is the configured API budget, not a cost quote. Subscription/local/unreported costs are not estimated. Use --confirm-run to execute. No patch is applied to the original workspace.",
          });
          return;
        }
        const report = await compareRuns(
          suite,
          config,
          store,
          () => harness(config, paths, store),
          signal,
          (partial) =>
            cli.progress("comparison_progress", {
              reportId: partial.id,
              attempts: partial.rows.length,
              complete: partial.complete,
            }),
        );
        print({ report, summary: comparisonSummary(report) });
        if (
          report.rows.some(
            (row) => row.state !== "succeeded" || !row.comparable,
          )
        )
          process.exitCode = 1;
      }),
    );
  program
    .command("eval-report <id>")
    .description("Read a private comparison report; no model calls")
    .option("--summary-only", "Omit per-attempt detail")
    .action((id: string, options) =>
      context(async (_config, paths) => {
        const report = await readComparison(paths, id);
        print(
          options.summaryOnly
            ? {
                id: report.id,
                complete: report.complete,
                summary: comparisonSummary(report),
                limitations: report.limitations,
              }
            : { report, summary: comparisonSummary(report) },
        );
      }),
    );
  program
    .command("eval-assess <id> <run-id>")
    .description(
      "Record evidence-backed human assessment of one comparison attempt",
    )
    .requiredOption(
      "--assessment <file>",
      "JSON/YAML: reviewer, accepted, majorDefects, reworkCount, evidence",
    )
    .requiredOption(
      "--confirm",
      "Confirm writing the assessment; previous assessments remain in its audit log",
    )
    .action((id: string, runId: string, options) =>
      context(async (_config, paths) => {
        const assessment = parse(
          await readText(resolve(options.assessment), 32_000),
          { maxAliasCount: 0 },
        );
        const report = await assessComparison(paths, id, runId, assessment);
        print({
          id: report.id,
          summary: comparisonSummary(report),
          assessmentLog: report.assessmentLog,
        });
      }),
    );
}
