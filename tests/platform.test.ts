import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, validateConfig } from "../src/config.js";
import { defaultBackend, defaultHome } from "../src/platform.js";
import { Sandbox } from "../src/sandbox.js";
import { sha256 } from "../src/util.js";

const execution = () =>
  configSchema.parse({
    schemaVersion: 1,
    execution: { backend: "bubblewrap" },
  }).execution;

test("OS defaults select a usable sandbox and conventional private storage without changing explicit policies", () => {
  assert.equal(defaultBackend("linux"), "bubblewrap");
  assert.equal(defaultBackend("darwin"), "disabled");
  assert.equal(defaultBackend("win32"), "disabled");
  assert.equal(
    defaultHome("darwin", "/Users/me"),
    "/Users/me/Library/Application Support/Local Agent",
  );
  assert.equal(
    defaultHome("linux", "/home/me"),
    "/home/me/.local/share/local-agent",
  );
  assert.equal(
    validateConfig({ schemaVersion: 1, execution: { backend: "bubblewrap" } })
      .execution.backend,
    "bubblewrap",
  );
  const config = validateConfig({
    schemaVersion: 1,
    execution: { backend: "bubblewrap" },
    mcp: {
      docs: {
        transport: "stdio",
        command: "/usr/bin/server",
        commandSha256: "a".repeat(64),
        tools: {},
      },
    },
  });
  assert.equal(config.mcp.docs?.transport, "stdio");
});

test("non-Linux platforms and disabled backends fail before dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-backend-"));
  try {
    await assert.rejects(
      () => new Sandbox(execution(), "darwin").invocation(root, ["/bin/sh"]),
      /requires Linux/,
    );
    await assert.rejects(
      () => new Sandbox(execution(), "win32").invocation(root, ["/bin/sh"]),
      /requires Linux/,
    );
    await assert.rejects(
      () =>
        new Sandbox(
          { ...execution(), backend: "disabled" },
          "linux",
        ).invocation(root, ["/bin/sh"]),
      /disabled/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifyExecutable hashes the host program and rejects changed programs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-image-"));
  try {
    const command = join(root, "server");
    await writeFile(command, "fixture");
    const sandbox = new Sandbox(execution(), "linux", async () => ({
      code: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    }));
    await sandbox.verifyExecutable(command, sha256("fixture"));
    await assert.rejects(
      () => sandbox.verifyExecutable(command, "c".repeat(64)),
      /pinned hash/,
    );
    await assert.rejects(
      () => sandbox.verifyExecutable("server", sha256("fixture")),
      /absolute path/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real Bubblewrap isolates commands and preserves host workspace changes", async (t) => {
  if (process.platform !== "linux")
    return t.skip("Bubblewrap integration is Linux-only");
  const root = await mkdtemp(join(tmpdir(), "agent-bwrap-live-"));
  const work = join(root, "work");
  await mkdir(work);
  try {
    const sandbox = new Sandbox(execution());
    const probe = await sandbox.probe(work);
    if (!probe.ok) {
      if (process.env.AGENT_REQUIRE_SANDBOX === "1") assert.fail(probe.detail);
      t.skip(probe.detail);
      return;
    }
    const signal = new AbortController().signal;
    assert.equal(
      (await sandbox.execute(work, "printf changed > result.txt", signal)).code,
      0,
    );
    assert.equal(
      (await sandbox.execute(work, "cat result.txt", signal, true)).stdout,
      "changed",
    );
    assert.notEqual(
      (await sandbox.execute(work, "printf denied > result.txt", signal, true))
        .code,
      0,
    );
    assert.notEqual(
      (await sandbox.execute(work, "printf denied > /usr/host-test", signal))
        .code,
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
