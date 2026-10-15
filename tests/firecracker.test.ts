import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { AgentError } from "../src/types.js";
import {
  FIRECRACKER_HELPER,
  FirecrackerEnvironment,
} from "../src/execution/firecracker.js";
import type { EnvironmentInfo } from "../src/execution/types.js";
import { runProcess, cleanEnvironment } from "../src/process.js";

const id = "123e4567-e89b-12d3-a456-426614174000";
const info: EnvironmentInfo = {
  id,
  backend: "firecracker",
  state: "ready",
  workspace: "/workspace",
};

test("Firecracker environment sends only bounded requests to the fixed helper", async () => {
  const requests: unknown[] = [];
  const environment = new FirecrackerEnvironment(async (request) => {
    requests.push(request);
    if (request.op === "execute")
      return {
        ok: true,
        result: { code: 0, stdout: "ok", stderr: "", truncated: false },
      };
    return { ok: true, result: info };
  });
  assert.deepEqual(await environment.start(id), info);
  assert.deepEqual(
    await environment.execute(id, {
      argv: ["/bin/printf", "ok"],
      timeoutMs: 1000,
      maxOutputBytes: 100,
    }),
    { code: 0, stdout: "ok", stderr: "", truncated: false },
  );
  assert.deepEqual(requests, [
    { op: "start", id },
    {
      op: "execute",
      id,
      command: {
        argv: ["/bin/printf", "ok"],
        timeoutMs: 1000,
        maxOutputBytes: 100,
      },
    },
  ]);
  assert.equal(
    FIRECRACKER_HELPER,
    "/usr/local/libexec/local-agent-firecracker",
  );
});

test("invalid IDs and command limits never invoke a fallback backend", async () => {
  let calls = 0;
  const environment = new FirecrackerEnvironment(async () => {
    calls++;
    return { ok: true, result: info };
  });
  await assert.rejects(
    environment.status("/tmp/host-path"),
    (error: unknown) =>
      error instanceof AgentError && error.code === "FIRECRACKER_REQUEST",
  );
  await assert.rejects(
    environment.status(12 as unknown as string),
    (error: unknown) =>
      error instanceof AgentError && error.code === "FIRECRACKER_REQUEST",
  );
  await assert.rejects(
    environment.execute(id, {
      argv: ["/bin/sh"],
      timeoutMs: 601000,
      maxOutputBytes: 100,
    }),
    (error: unknown) =>
      error instanceof AgentError && error.code === "FIRECRACKER_REQUEST",
  );
  assert.equal(calls, 0);
});

test("argv preserves empty argument values and bounds untrusted helper output", async () => {
  let received: unknown;
  const environment = new FirecrackerEnvironment(async (request) => {
    received = request;
    return {
      ok: true,
      result: { code: 0, stdout: "four", stderr: "", truncated: false },
    };
  });
  await assert.rejects(
    environment.execute(id, {
      argv: ["/bin/printf", ""],
      timeoutMs: 1000,
      maxOutputBytes: 3,
    }),
    (error: unknown) =>
      error instanceof AgentError && error.code === "FIRECRACKER_PROTOCOL",
  );
  assert.deepEqual(received, {
    op: "execute",
    id,
    command: {
      argv: ["/bin/printf", ""],
      timeoutMs: 1000,
      maxOutputBytes: 3,
    },
  });
});

test("malformed helper failures are not reported as successful execution", async () => {
  const environment = new FirecrackerEnvironment(async () => ({
    ok: false,
    error: { code: "UNKNOWN_RESULT", message: "transport lost" },
  }));
  await assert.rejects(
    environment.execute(id, {
      argv: ["/bin/true"],
      timeoutMs: 1000,
      maxOutputBytes: 100,
    }),
    (error: unknown) =>
      error instanceof AgentError && error.code === "UNKNOWN_RESULT",
  );
});

test("environment CLI rejects invalid IDs without loading configuration or falling back", async () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const result = await runProcess(
    process.execPath,
    [cli, "--json", "environment", "status", "not-a-uuid"],
    { env: cleanEnvironment, timeoutMs: 30000, maxBytes: 10000 },
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /UUID/);
});
