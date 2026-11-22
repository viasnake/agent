import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  commandProgressSchema,
  replySchema,
} from "../src/execution/protocol.js";
import type { WorkerRequest, WorkerResult } from "../src/execution/protocol.js";
import { reviewRepository } from "./git-review-fixture.js";

test("S02: real worker stdio protocol, file operations, command cancellation and allowlisted shell environment", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agent-worker-protocol-")),
    root = join(temporary, "custom data", "work"),
    conversationId = randomUUID();
  const child = spawn(
    process.execPath,
    [resolve(".test-dist/tests/worker-child.js"), root],
    {
      env: { ...process.env, AGENT_CONTROL_TOKEN: "synthetic-protocol-secret" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let buffered = "";
  const progress = new Map<string, string>();
  const pending = new Map<
    string,
    { resolve: (value: WorkerResult) => void; reject: (error: Error) => void }
  >();
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    buffered += String(chunk);
    let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const value = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      if ("progress" in value) {
        const update = commandProgressSchema.parse(value);
        assert.ok(pending.has(update.id));
        progress.set(update.id, update.progress.text);
        continue;
      }
      const reply = replySchema.parse(value);
      const waiter = pending.get(reply.id);
      assert.ok(waiter, "Unsolicited protocol reply");
      pending.delete(reply.id);
      if (reply.ok && reply.result) waiter.resolve(reply.result);
      else waiter.reject(new Error(reply.error));
    }
  });
  child.on("exit", () => {
    for (const waiter of pending.values())
      waiter.reject(new Error("Worker exited"));
    pending.clear();
  });
  const send = (op: WorkerRequest["op"], args: Record<string, unknown>) => {
    const id = randomUUID();
    const result = new Promise<WorkerResult>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    child.stdin.write(JSON.stringify({ id, conversationId, op, args }) + "\n");
    return { id, result };
  };
  try {
    assert.equal((await send("health", {}).result).uid, process.getuid?.());
    await send("init", {}).result;
    const checkout = join(root, "conversations", conversationId, "checkout");
    const { head } = await reviewRepository(checkout);
    assert.deepEqual(
      (await send("git_review", { kind: "changes", repo: "checkout" }).result)
        .gitReview,
      {
        kind: "changes",
        head,
        files: [{ path: "app.txt", status: "M" }],
        limited: false,
      },
    );
    const tool = (name: string, args: Record<string, unknown>) =>
      send("tool", { name, args, commandSeconds: 40, commandBytes: 1048576 });
    const longCommand = send("long_command", {
      args: { command: "echo wire-started; exec sleep 20" },
      commandSeconds: 600,
      commandBytes: 1024,
    });
    const deadline = Date.now() + 5000;
    while (!progress.has(longCommand.id) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(progress.get(longCommand.id), "wire-started\n");
    child.stdin.write(
      JSON.stringify({ type: "cancel", id: longCommand.id }) + "\n",
    );
    assert.equal((await longCommand.result).result?.isError, true);
    const identity = (await send("git_identity", {}).result).gitIdentity;
    assert.ok(identity && !("conflict" in identity));
    assert.equal(identity.name, "");
    const gitConfig = await send("git_identity", {
      input: {
        ...identity,
        name: "Worker User",
        email: "worker@example.invalid",
      },
    }).result;
    assert.deepEqual(await send("git_identity", {}).result, gitConfig);
    const gitAuthor = await tool("bash", {
      command: "git var GIT_AUTHOR_IDENT",
    }).result;
    assert.equal(gitAuthor.result?.isError, undefined);
    assert.match(
      JSON.stringify(gitAuthor.result?.output),
      /Worker User <worker@example\.invalid>/,
    );
    await tool("write", {
      path: "outputs/message.txt",
      content: "実プロトコルの確認",
    }).result;
    assert.match(
      JSON.stringify(
        await tool("read", { path: "outputs/message.txt" }).result,
      ),
      /実プロトコルの確認/,
    );
    const environment = await tool("bash", {
      command:
        'test -z "${AGENT_CONTROL_TOKEN-}${NODE_OPTIONS-}${LD_PRELOAD-}"',
    }).result;
    assert.equal(environment.result?.isError, undefined);
    const home = join(root, "home"),
      localBin = join(home, ".local", "bin"),
      outputs = join(root, "conversations", conversationId, "outputs"),
      runtimeCommand =
        "set -e; command -v node python3 sh; node --version; python3 --version";
    const runtimes = await tool("bash", { command: runtimeCommand }).result;
    assert.equal(runtimes.result?.isError, undefined);
    await mkdir(localBin, { recursive: true });
    await writeFile(
      join(localBin, "agent-path-probe"),
      '#!/bin/sh\nset -eu\ntest -z "${AGENT_CONTROL_TOKEN-}"\nprintf \'%s\\n\' local-cli "$HOME" "$PATH"\n',
      { mode: 0o700 },
    );
    // Local names must not shadow existing runtimes or system commands.
    for (const name of ["node", "python3", "sh"])
      await writeFile(join(localBin, name), "#!/bin/sh\nexit 99\n", {
        mode: 0o700,
      });
    for (const name of [".bashrc", ".profile", ".bash_profile"])
      await writeFile(join(home, name), "exit 99\n");
    const local = await tool("bash", {
      command: "agent-path-probe > outputs/local-cli",
    }).result;
    assert.equal(local.result?.isError, undefined, JSON.stringify(local));
    const expected = [
      "local-cli",
      home,
      `/opt/agent-node/bin:/opt/agent-python/bin:/usr/local/bin:/usr/bin:/bin:${localBin}`,
      "",
    ].join("\n");
    assert.equal(await readFile(join(outputs, "local-cli"), "utf8"), expected);
    const unchanged = await tool("bash", { command: runtimeCommand }).result;
    assert.equal(unchanged.result?.isError, undefined);
    assert.deepEqual(unchanged.result?.output, runtimes.result?.output);
    // A configured stdio MCP process receives the same work-side PATH.
    const mcpCommand = join(localBin, "agent-mcp-probe");
    await writeFile(
      mcpCommand,
      '#!/bin/sh\nset -eu\nagent-path-probe > outputs/mcp-cli\nexec "$@"\n',
      { mode: 0o700 },
    );
    const server = {
      name: "local-path",
      command: mcpCommand,
      args: [process.execPath, resolve(".test-dist/tests/mcp-server.js")],
      env: {},
    };
    assert.ok(
      (await send("mcp_list", { server }).result).tools?.some(
        (entry) => entry.name === "greet",
      ),
    );
    assert.equal(await readFile(join(outputs, "mcp-cli"), "utf8"), expected);
    const greeting = await send("mcp_call", {
      server,
      name: "greet",
      args: { name: "local CLI" },
    }).result;
    assert.equal(greeting.result?.isError, false);
    assert.match(JSON.stringify(greeting), /Hello local CLI/);
    const running = tool("bash", {
      command: "printf started > child-marker; sleep 30",
    });
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await readFile(
          join(root, "conversations", conversationId, "child-marker"),
        );
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    }
    child.stdin.write(
      JSON.stringify({ type: "cancel", id: running.id }) + "\n",
    );
    assert.equal((await running.result).result?.isError, true);
    assert.equal((await send("cleanup", {}).result).cleanup, true);
  } finally {
    const exit = new Promise<void>((resolveExit, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Worker did not shut down"));
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
    child.stdin.end();
    await exit;
    await rm(temporary, { recursive: true, force: true });
  }
});
