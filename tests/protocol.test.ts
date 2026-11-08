import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { replySchema } from "../src/execution/protocol.js";
import type { WorkerRequest, WorkerResult } from "../src/execution/protocol.js";

test("S02: real worker stdio protocol, file operations, command cancellation and allowlisted shell environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-worker-protocol-")),
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
  const pending = new Map<
    string,
    { resolve: (value: WorkerResult) => void; reject: (error: Error) => void }
  >();
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    buffered += String(chunk);
    let end: number;
    while ((end = buffered.indexOf("\n")) >= 0) {
      const reply = replySchema.parse(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
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
    const tool = (name: string, args: Record<string, unknown>) =>
      send("tool", { name, args, commandSeconds: 40, commandBytes: 1048576 });
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
  }
});
