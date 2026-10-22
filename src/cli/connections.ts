import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { endpointFetch } from "../network.js";
import {
  connectionRuntime,
  endpoint,
  login,
  providerId,
} from "../runtime/providers.js";
import { AgentError } from "../types.js";
import type { CliContext } from "./context.js";
import { chatGPTLoginLink } from "./auth-link.js";
export function registerConnectionsCommands(cli: CliContext): void {
  const {
    program,
    signal,
    print,
    progress,
    context,
    harness,
    status,
    exitForRun,
  } = cli;
  const auth = program
    .command("auth")
    .description("Manage connection-specific authentication");
  auth
    .command("login <connection>")
    .description("Sign in with ChatGPT using the SDK public OAuth flow")
    .action((name: string) =>
      context(async (config, p) => {
        if (!stdin.isTTY)
          throw new AgentError("AUTH", "Interactive login requires a terminal");
        const reader = createInterface({ input: stdin, output: stdout });
        try {
          await login(config, p, name, {
            signal: signal,
            notify: (event) => {
              if (event.type === "auth_url") {
                if (program.opts().json)
                  print({ url: event.url, instructions: event.instructions });
                else {
                  // This validated link intentionally bypasses print's ANSI stripping.
                  stdout.write(chatGPTLoginLink(event.url, !!stdout.isTTY));
                  if (event.instructions) print(event.instructions);
                }
              } else if (event.type === "device_code")
                print({ url: event.verificationUri, code: event.userCode });
              else print(event.message);
            },
            prompt: async (prompt) => {
              if (prompt.type === "secret")
                throw new AgentError(
                  "AUTH",
                  "Secret entry is not supported here; use the configured environment variable",
                );
              const promptSignal = AbortSignal.any([
                signal,
                ...(prompt.signal ? [prompt.signal] : []),
              ]);
              return reader.question(
                `${prompt.message}${prompt.type === "select" ? "\n" + prompt.options.map((o) => `${o.id}: ${o.label}`).join("\n") : ""}\n> `,
                { signal: promptSignal },
              );
            },
          });
          print({ connection: name, authenticated: true });
        } finally {
          reader.close();
        }
      }),
    );
  auth.command("status <connection>").action((name: string) =>
    context(async (config, p) => {
      const conn = config.connections[name];
      if (!conn) throw new AgentError("AUTH", "Unknown connection");
      const credentials =
        conn.type === "chatgpt"
          ? await (await connectionRuntime(config, p, name)).listCredentials()
          : [];
      print({
        connection: name,
        account: conn.account,
        type: conn.type,
        authenticated:
          conn.type === "chatgpt"
            ? credentials.some(
                (c) => c.providerId === "openai" && c.type === "oauth",
              )
            : conn.type === "local" ||
              !!(conn.secretEnv && process.env[conn.secretEnv]),
        subscriptionQuota: "unknown",
      });
    }),
  );
  auth
    .command("logout <connection>")
    .description(
      "Remove this app’s local ChatGPT credential; does not revoke provider-side access",
    )
    .action((name: string) =>
      context(async (config, p) => {
        const runtime = await connectionRuntime(config, p, name);
        await runtime.logout(providerId(config.connections[name]!));
        print({
          connection: name,
          localCredentialRemoved: true,
          providerRevocation: "not performed",
        });
      }),
    );
  const models = program
    .command("models")
    .description("List and probe configured models");
  models
    .command("list")
    .option("--connection <name>", "show SDK catalog for a connection")
    .option(
      "--remote",
      "retrieve account-specific model catalog (network access)",
    )
    .action((options) =>
      context(async (config, p) => {
        if (!options.connection) {
          print(config.models);
          return;
        }
        const name = options.connection as string,
          conn = config.connections[name];
        if (!conn) throw new AgentError("CONFIG", "Unknown connection");
        const runtime = await connectionRuntime(config, p, name);
        if (!options.remote) {
          print({
            connection: name,
            source: "SDK catalog; account access unverified",
            models: runtime.getModels(providerId(conn)).map((m) => ({
              id: m.id,
              name: m.name,
              contextWindow: m.contextWindow,
              maxTokens: m.maxTokens,
            })),
          });
          return;
        }
        if (!conn.enabled)
          throw new AgentError(
            "CONNECTION_DISABLED",
            "Enable the connection before accessing its remote catalog",
          );
        if (
          conn.type === "chatgpt" &&
          !(await runtime.listCredentials()).some(
            (c) => c.providerId === "openai" && c.type === "oauth",
          )
        )
          throw new AgentError("AUTH", "ChatGPT login required");
        const auth = await runtime.getAuth(providerId(conn), {
          signal: signal,
        });
        if (!auth?.auth.apiKey)
          throw new AgentError("AUTH", "Connection credentials unavailable");
        const base = endpoint(conn),
          url = new URL(base.replace(/\/$/, "") + "/models");
        const response = await endpointFetch(
          base,
          AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        )(url, {
          headers:
            conn.type === "gemini"
              ? { "x-goog-api-key": auth.auth.apiKey }
              : { Authorization: `Bearer ${auth.auth.apiKey}` },
        });
        if (!response.ok)
          throw new AgentError(
            "MODELS",
            `Model listing returned HTTP ${response.status}`,
          );
        const data = (await response.json()) as {
          models?: Array<{
            slug?: string;
            display_name?: string;
            visibility?: string;
            name?: string;
          }>;
          data?: unknown;
        };
        print({
          connection: name,
          source: "remote account catalog",
          models:
            conn.type === "chatgpt"
              ? data.models
                  ?.filter((m) => m.visibility === "list")
                  .map((m) => ({ id: m.slug, name: m.display_name }))
              : (data.models ?? data.data),
        });
      }),
    );
  models
    .command("probe <model>")
    .description(
      "Make real model calls and a file-tool round trip; consumes configured quota/budget",
    )
    .action((model: string) =>
      context(async (config, p, store) => {
        const selected = config.models[model];
        if (!selected) throw new AgentError("NO_MODEL", "Unknown model");
        const probeConfig = structuredClone(config);
        probeConfig.models[model]!.tools = true;
        probeConfig.models[model]!.roles = ["worker"];
        probeConfig.models[model]!.kinds = ["writing"];
        probeConfig.execution.backend = "disabled";
        probeConfig.web.allowedHosts = [];
        probeConfig.mcp = {};
        probeConfig.routing.mode = "rules";
        probeConfig.limits.maxRequests = Math.min(config.limits.maxRequests, 6);
        const runner = harness(probeConfig, p, store),
          run = await runner.create({
            kind: "writing",
            mode: "single",
            model,
            dataClass: "public",
            objective:
              'Create probe.md containing exactly "Agent connection works." Read it back with read_file. Report it as your artifact. Do not use shell or network tools.',
            mustKeep: ["Agent connection works."],
          });
        progress("live_probe", { runId: run.id });
        const result = await runner.execute(run.id, signal);
        status(store, result);
        exitForRun(result);
      }),
    );
}
