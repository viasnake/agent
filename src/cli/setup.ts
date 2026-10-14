import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { configHash, initialize, paths } from "../config.js";
import { connectionRuntime } from "../runtime/providers.js";
import { Sandbox } from "../sandbox.js";
import type { CliContext } from "./context.js";
export function registerSetupCommands(cli: CliContext): void {
  const { program, print, context } = cli;
  program
    .command("init")
    .description("Create private storage and configuration")
    .option("--template <file>", "use a reviewed YAML configuration")
    .action(async (options) => {
      const p = paths(program.opts().home);
      await initialize(
        p,
        options.template
          ? parse(await readFile(resolve(options.template), "utf8"), {
              maxAliasCount: 0,
            })
          : undefined,
      );
      print({
        config: p.config,
        next: "Configure connections and models, then run agent doctor. See examples/config.yaml.",
      });
    });
  const configCommand = program
    .command("config")
    .description("Inspect trusted configuration");
  configCommand
    .command("path")
    .action(() => print(paths(program.opts().home).config));
  configCommand
    .command("validate")
    .action(() =>
      context(async (config, p) =>
        print({ valid: true, path: p.config, sha256: configHash(config) }),
      ),
    );
  program
    .command("doctor")
    .description(
      "Check configuration, credentials and isolation locally; does not call model APIs",
    )
    .action(() =>
      context(async (config, p) => {
        const directory = await mkdtemp(join(p.home, "doctor-"));
        try {
          const sandbox =
              config.execution.backend === "disabled"
                ? {
                    ok: true,
                    detail: "Command execution is disabled by configuration",
                  }
                : await new Sandbox(config.execution).probe(directory),
            connections = [];
          for (const [name, conn] of Object.entries(config.connections)) {
            let credential =
              conn.type === "local" ||
              !!(conn.secretEnv && process.env[conn.secretEnv]);
            if (conn.type === "chatgpt")
              credential = (
                await (
                  await connectionRuntime(config, p, name)
                ).listCredentials()
              ).some((c) => c.providerId === "openai" && c.type === "oauth");
            connections.push({
              name,
              type: conn.type,
              enabled: conn.enabled,
              account: conn.account,
              credential: credential ? "present" : "missing",
              allowedData: conn.allowedData,
              billing: conn.billing,
              requestReservationUsd: conn.maxRequestUsd,
            });
          }
          print({
            node: process.version,
            platform: process.platform,
            architecture: process.arch,
            pi: "1.2.0",
            config: p.config,
            sandbox,
            connections,
            models: Object.keys(config.models),
            limits: config.limits,
            liveInference: "not tested",
          });
          if (
            !sandbox.ok ||
            !Object.values(config.connections).some((c) => c.enabled)
          )
            process.exitCode = 2;
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }),
    );
}
