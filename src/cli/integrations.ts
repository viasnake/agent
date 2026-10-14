import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { type NewRun } from "../harness.js";
import { loginMcp } from "../mcp-auth.js";
import { McpTools } from "../mcp.js";
import { Sandbox } from "../sandbox.js";
import type { CliContext } from "./context.js";
export function registerIntegrationsCommands(cli: CliContext): void {
  const { program, signal, print, context, harness } = cli;
  const mcp = program
    .command("mcp")
    .description("Inspect pinned read-only MCP tools and manage OAuth");
  mcp
    .command("list <server>")
    .description(
      "Connect and print tool schemas/hashes without granting permission",
    )
    .action((name: string) =>
      context(async (config, p) => {
        const directory = await mkdtemp(join(p.home, "mcp-inspect-")),
          manager = new McpTools(
            config,
            p,
            new Sandbox(config.execution),
            directory,
            signal,
          );
        try {
          print(await manager.catalog(name));
        } finally {
          await manager.close();
          await rm(directory, { recursive: true, force: true });
        }
      }),
    );
  mcp.command("login <server>").action((name: string) =>
    context(async (config, p) => {
      await loginMcp(config, p, name, signal, (url) =>
        print({
          url,
          sshForward: "Forward local port 1456 to the VM for the callback",
        }),
      );
      print({ server: name, authenticated: true });
    }),
  );
  program
    .command("eval")
    .requiredOption(
      "--suite <file>",
      "YAML/JSON evaluation suite; real calls consume quota/budget",
    )
    .option("--prepare-only", "validate and display cases without running them")
    .action((options) =>
      context(async (config, p, store) => {
        const suite = z
          .strictObject({
            name: z.string().min(1),
            cases: z
              .array(
                z.strictObject({
                  id: z.string().min(1),
                  objective: z.string().min(1),
                  kind: z.enum(["coding", "research", "writing"]),
                  mode: z.enum(["single", "assisted", "reviewed"]),
                  model: z.string().optional(),
                  reviewer: z.string().optional(),
                  workspace: z.string().optional(),
                  inputs: z.array(z.string()).optional(),
                  checks: z.array(z.string()).optional(),
                  mustKeep: z.array(z.string()).optional(),
                  dataClass: z
                    .enum(["public", "private", "restricted"])
                    .default("private"),
                  localOnly: z.boolean().default(false),
                }),
              )
              .min(1)
              .max(100),
          })
          .parse(
            parse(await readFile(resolve(options.suite), "utf8"), {
              maxAliasCount: 0,
            }),
          );
        if (options.prepareOnly) {
          print(suite);
          return;
        }
        const results = [];
        for (const entry of suite.cases) {
          signal.throwIfAborted();
          const runner = harness(config, p, store),
            run = await runner.create(entry as NewRun),
            result = await runner.execute(run.id, signal);
          results.push({
            case: entry.id,
            runId: run.id,
            state: result.state,
            elapsedMs: result.elapsedMs,
            usage: store.usage(run.id),
            models: result.tasks.map((t) => t.model),
          });
        }
        print({ suite: suite.name, results });
        if (results.some((r) => r.state !== "succeeded")) process.exitCode = 1;
      }),
    );
}
