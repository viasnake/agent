import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema, validateConfig } from "../src/config.js";
import {
  defaultBackend,
  defaultHome,
  podmanEnvironment,
} from "../src/platform.js";
import { Sandbox } from "../src/sandbox.js";
import { type ProcessOptions, type ProcessResult } from "../src/process.js";
import { AgentError } from "../src/types.js";

const image = `localhost/agent-fixture@sha256:${"a".repeat(64)}`;
const execution = () =>
  configSchema.parse({
    schemaVersion: 1,
    execution: { backend: "podman", image },
  }).execution;
const ok = (stdout = ""): ProcessResult => ({
  code: 0,
  stdout,
  stderr: "",
  truncated: false,
});

test("OS defaults select a usable sandbox and conventional private storage without changing explicit policies", () => {
  assert.equal(defaultBackend("darwin"), "podman");
  assert.equal(defaultBackend("linux"), "bubblewrap");
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
    execution: { backend: "podman", image },
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

test("Podman host credentials are limited to its connection and never become container environment arguments", async () => {
  const env = podmanEnvironment({
    HOME: "/Users/test",
    PATH: "/opt/homebrew/bin:/usr/bin",
    SSH_AUTH_SOCK: "/private/socket",
    OPENAI_API_KEY: "fixture-secret",
    AWS_SECRET_ACCESS_KEY: "fixture-secret",
  });
  assert.equal(env.HOME, "/Users/test");
  assert.equal(env.SSH_AUTH_SOCK, "/private/socket");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  const root = await mkdtemp(join(tmpdir(), "agent podman "));
  const calls: Array<{ args: string[]; options: ProcessOptions }> = [];
  const runner = async (
    _command: string,
    args: string[],
    options: ProcessOptions = {},
  ) => {
    calls.push({ args, options });
    return args[0] === "info" ? ok("true\n") : ok("tool output");
  };
  try {
    const sandbox = new Sandbox(execution(), "darwin", runner);
    assert.equal(
      (
        await sandbox.execute(
          root,
          "printf hello",
          new AbortController().signal,
          true,
        )
      ).stdout,
      "tool output",
    );
    const args = calls[1]!.args;
    assert.ok(args.includes("--network=none"));
    assert.ok(args.includes("--pull=never"));
    assert.ok(args.includes("--interactive"));
    assert.ok(args.includes("--entrypoint=/bin/sh"));
    assert.ok(args.some((arg) => arg.endsWith(":/workspace:ro")));
    assert.deepEqual(
      args.filter((arg) => arg.startsWith("--env=")),
      ["--env=HOME=/tmp", "--env=TMPDIR=/tmp"],
    );
    assert.deepEqual(args.slice(-3), [image, "-c", "printf hello"]);
    const name = args.find((arg) => arg.startsWith("--name="))!.slice(7);
    assert.deepEqual(calls[2]!.args, ["rm", "--force", "--ignore", name]);
    assert.equal(calls[2]!.options.signal, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Podman cancels remote containers even when the local client aborts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-cancel-"));
  const calls: string[][] = [];
  const controller = new AbortController();
  const runner = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "run") {
      controller.abort();
      throw new AgentError("CANCELLED", "cancelled");
    }
    return ok("true");
  };
  try {
    await assert.rejects(
      () =>
        new Sandbox(execution(), "darwin", runner).execute(
          root,
          "sleep 30",
          controller.signal,
        ),
      /cancelled/,
    );
    assert.equal(calls.at(-1)?.[0], "rm");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed Podman cleanup cannot report a successful tool result", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-cleanup-"));
  try {
    const sandbox = new Sandbox(
      execution(),
      "darwin",
      async (_command, args) =>
        args[0] === "rm" ? { ...ok(), code: 125 } : ok("true"),
    );
    await assert.rejects(
      () => sandbox.execute(root, "true", new AbortController().signal),
      (error: unknown) =>
        error instanceof AgentError && error.code === "SANDBOX_CLEANUP",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported backends, rootful engines and host runtime mounts fail before dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-backend-"));
  try {
    await assert.rejects(
      () =>
        new Sandbox(
          { ...execution(), backend: "bubblewrap" },
          "darwin",
        ).invocation(root, ["/bin/sh"]),
      /requires Linux/,
    );
    await assert.rejects(
      () =>
        new Sandbox(execution(), "darwin", async () => ok("false")).invocation(
          root,
          ["/bin/sh"],
        ),
      /rootless/,
    );
    await assert.rejects(
      () =>
        new Sandbox(
          { ...execution(), runtimePaths: ["/opt/node"] },
          "darwin",
        ).invocation(root, ["/bin/sh"]),
      /pinned Linux image/,
    );
    await assert.rejects(
      () =>
        new Sandbox({ ...execution(), image: undefined }, "darwin").invocation(
          root,
          ["/bin/sh"],
        ),
      /pinned by sha256/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Podman MCP hashes the image executable and rejects changed or mutable programs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-image-"));
  const calls: string[][] = [];
  const digest = "b".repeat(64);
  const runner = async (_command: string, args: string[]) => {
    calls.push(args);
    return ok(args[0] === "run" ? `${digest}  /usr/bin/server\n` : "true");
  };
  try {
    const sandbox = new Sandbox(execution(), "darwin", runner);
    const signal = new AbortController().signal;
    await sandbox.verifyExecutable(root, "/usr/bin/server", digest, signal);
    assert.ok(calls[1]!.includes("--entrypoint=/usr/bin/sha256sum"));
    assert.deepEqual(calls[1]!.slice(-3), [image, "--", "/usr/bin/server"]);
    await assert.rejects(
      () =>
        sandbox.verifyExecutable(
          root,
          "/usr/bin/server",
          "c".repeat(64),
          signal,
        ),
      /pinned hash/,
    );
    await assert.rejects(
      () => sandbox.verifyExecutable(root, "/workspace/server", digest, signal),
      /immutable image/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real Podman isolates commands and preserves host workspace changes", async (t) => {
  const configuredImage = process.env.AGENT_TEST_PODMAN_IMAGE;
  if (!configuredImage) {
    if (process.env.AGENT_REQUIRE_PODMAN === "1")
      assert.fail(
        "Set AGENT_TEST_PODMAN_IMAGE to a preloaded digest-pinned Linux image",
      );
    t.skip("AGENT_TEST_PODMAN_IMAGE is not configured");
    return;
  }
  // On macOS this directory must be shared with Podman machine at the same path.
  const root = await mkdtemp(
    join(
      process.env.AGENT_TEST_PODMAN_DIRECTORY ?? tmpdir(),
      "agent-podman-live-",
    ),
  );
  const work = join(root, "work");
  await mkdir(work);
  try {
    const sandbox = new Sandbox({ ...execution(), image: configuredImage });
    const probe = await sandbox.probe(work);
    assert.equal(probe.ok, true, probe.detail);
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
      (await sandbox.execute(work, "printf denied > /etc/host-test", signal))
        .code,
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
