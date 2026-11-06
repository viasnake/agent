import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Storage } from "@earendil-works/pi-durable";
import { fixture, jobInput, call } from "./support.js";
import { GithubConnector } from "../src/integrations/github.js";
import type { GithubTransport } from "../src/integrations/github.js";
import { AppError } from "../src/security.js";
import { AppDoc } from "../src/state.js";
import { mkdir } from "node:fs/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";

const [mode, root, value] = process.argv.slice(2);
if (!root) throw new Error("A test root is required");
await mkdir(join(root, "control"), { recursive: true, mode: 0o700 });
let armed = false;
let storage: Storage | undefined;
if (mode === "before-commit" || mode === "after-commit") {
  const actual = await openNodeSqliteStorage(
    join(root, "control/state.sqlite"),
  );
  storage = new Proxy(actual, {
    get(target, key) {
      if (key === "commit")
        return async (...args: Parameters<Storage["commit"]>) => {
          if (!armed) return actual.commit(...args);
          if (mode === "after-commit") await actual.commit(...args);
          process.send?.({ stage: mode });
          return new Promise<never>(() => undefined);
        };
      const property: unknown = Reflect.get(target, key);
      return typeof property === "function" ? property.bind(target) : property;
    },
  });
}
const transport: GithubTransport = async (path, method, body) => {
  const response = await fetch(`http://127.0.0.1:${value}${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer synthetic-control-only",
    },
  });
  if (!response.ok) throw new AppError(response.status, "fixture");
  return response.json() as Promise<unknown>;
};
const providerResponses =
  mode === "model"
    ? [
        async () => {
          process.send?.({ stage: "model-dispatched" });
          await new Promise<never>(() => undefined);
          return fauxAssistantMessage("unreachable");
        },
      ]
    : mode === "shell"
      ? [
          call("shell", {
            command:
              "printf 'once\\n' >> executions; printf '%s' $$ > shell.pid; sleep 60",
          }),
        ]
      : [];
const { service, config } = await fixture(providerResponses, {
  dataRoot: root,
  noModel: mode !== "model" && mode !== "shell",
  storage,
  github:
    mode === "external"
      ? new GithubConnector(["fixture/repo"], transport)
      : undefined,
});
config.limits.modelRequests = 3;
process.send?.({ stage: "ready" });
process.on("message", (input) => {
  void (async () => {
    const requestId = (input as { requestId: string }).requestId;
    armed = true;
    const { id } = await service.create(
      jobInput({ requestId, externalAllowed: mode === "external" }),
    );
    process.send?.({ stage: "created", id });
    if (mode === "external") {
      await service.harness.commit(async (tx) => {
        (await tx.doc(AppDoc)).activeJobId = id;
      }, ctx);
      const operation = await service.proposeGithub(await service.job(id), {
        repository: "fixture/repo",
        branch: `codex/job-${id}`,
        base: "master",
        baseSha: "a".repeat(40),
        title: "Fix fixture",
        body: "Synthetic integration test",
        files: [{ path: "calc.py", content: "fixed\n" }],
      });
      await service.approve(
        id,
        requestId.replace(/.$/, requestId.endsWith("0") ? "1" : "0"),
        (await service.job(id)).revision,
        operation.id,
        true,
      );
    }
  })().catch((error) => {
    process.send?.({ stage: "error", error: String(error) });
    process.exit(1);
  });
});
setInterval(() => undefined, 1000);
