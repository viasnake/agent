import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { parse } from "yaml";
import { readText } from "../util.js";
import { reviewWriting } from "../writing-quality.js";
import { secretPath } from "../workspace.js";
import { AgentError } from "../types.js";
import type { CliContext } from "./context.js";

export function registerWritingCommands(cli: CliContext): void {
  cli.program
    .command("writing-check")
    .description(
      "Local literal/style checks only; no inference or complete semantic proofreading",
    )
    .requiredOption("--source <file>", "Original UTF-8 text")
    .requiredOption("--candidate <file>", "Candidate UTF-8 text")
    .option(
      "--must-keep <literal>",
      "User-required exact literal, repeatable",
      cli.collect,
      [],
    )
    .option("--style <style>", "polite | plain | unspecified", "unspecified")
    .option(
      "--terminology <file>",
      "JSON/YAML array of {preferred, alternatives}",
    )
    .action(async (options) => {
      for (const file of [
        options.source,
        options.candidate,
        options.terminology,
      ].filter(Boolean))
        if (
          secretPath(resolve(file)) ||
          secretPath(await realpath(resolve(file)))
        )
          throw new AgentError(
            "PATH_DENIED",
            "Credential/control files cannot be used as writing inputs",
          );
      const source = await readText(resolve(options.source), 1_000_000);
      const candidate = await readText(resolve(options.candidate), 1_000_000);
      const terminology = options.terminology
        ? parse(await readText(resolve(options.terminology), 64_000), {
            maxAliasCount: 0,
          })
        : [];
      const review = reviewWriting(source, candidate, {
        mustKeep: options.mustKeep,
        style: options.style,
        terminology,
      });
      cli.print(review);
      if (!review.requiredLiteralsPassed) process.exitCode = 1;
    });
}
