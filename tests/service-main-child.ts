import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mock } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import * as config from "../src/config.js";
import { AgentService } from "../src/service.js";
import { createServer } from "../src/server.js";
import { fixture, answer, until } from "./support.js";

const f = await fixture([answer("survivor answered")], {
  root: process.argv[2]!,
});
f.config.server.port = 0;
const server = await createServer(f.service);
// Only OS preflight and construction are replaced; the entry point owns shutdown.
mock.module(new URL("../src/config.js", import.meta.url), {
  exports: {
    ...config,
    loadConfig: async () => f.config,
    checkDataRoot: async () => {},
  },
});
mock.method(AgentService, "open", async () => f.service);
mock.module(new URL("../src/server.js", import.meta.url), {
  exports: { createServer: async () => server },
});
await import("../src/service-main.js");

const address = server.server.address();
assert.ok(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}`;
const headers: Record<string, string> = {
  host: "127.0.0.1:8080",
  origin: "http://127.0.0.1:8080",
};
async function request(path: string, method = "GET", body?: unknown) {
  const response = await new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      `${base}${path}`,
      {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode!,
              headers: { "set-cookie": res.headers["set-cookie"]?.[0] ?? "" },
            }),
          ),
        );
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal(response.ok, true, `${method} ${path}: ${response.status}`);
  return response;
}
const session = await request("/api/session");
headers.cookie = session.headers.get("set-cookie")!.split(";")[0]!;
headers["x-csrf-token"] = (await session.json()).csrf;
const target = await (
  await request("/api/conversations", "POST", {
    requestId: randomUUID(),
    title: "delete",
  })
).json();
const survivor = await (
  await request("/api/conversations", "POST", {
    requestId: randomUUID(),
    title: "survivor",
  })
).json();
const originalHarness = f.service.harness;
await request(`/api/conversations/${target.id}`, "DELETE");
assert.notEqual(f.service.harness, originalHarness);
await request("/healthz");
await request(`/api/conversations/${survivor.id}/messages`, "POST", {
  requestId: randomUUID(),
  text: "continue after deletion",
});
await until(
  async () => (await f.service.conversation(survivor.id)).status === "idle",
);
assert.match(
  await (await request(`/api/conversations/${survivor.id}`)).text(),
  /survivor answered/,
);
console.log("survivor-answered");

if (process.argv[3] === "harness-close") {
  // Closing the replacement outside AgentService simulates an unexpected end.
  await f.service.harness.close(ctx);
} else {
  process.kill(process.pid, "SIGTERM");
}
