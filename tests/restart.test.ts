import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, answer, call, until } from "./support.js";
test("actual SIGKILL retains interrupted Pi history and files without replaying the shell on reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-restart-")),
    child = spawn(
      process.execPath,
      [resolve(".test-dist/tests/restart-child.js"), root],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  child.stderr.resume();
  let shellPid: number | undefined;
  try {
    await until(async () =>
      readFile(join(root, "conversation-id")).then(
        () => true,
        () => false,
      ),
    );
    const id = (await readFile(join(root, "conversation-id"), "utf8")).trim(),
      base = join(root, "work/conversations", id);
    await until(async () =>
      readFile(join(base, "started")).then(
        () => true,
        () => false,
      ),
    );
    shellPid = Number(await readFile(join(base, "shell.pid"), "utf8"));
    await until(async () =>
      readFile(join(root, "queued")).then(
        () => true,
        () => false,
      ),
    );
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    // The privileged guest test separately verifies systemd cgroup cleanup. Reap this unprivileged fixture's orphan explicitly.
    try {
      process.kill(-shellPid, "SIGKILL");
    } catch {}
    const f = await fixture(
      [
        call("bash", { command: "cat outputs/effects.txt" }),
        answer("既存の結果を確認しました。更新は繰り返していません。"),
      ],
      { root },
    );
    try {
      assert.equal((await f.service.conversation(id)).status, "interrupted");
      assert.match(
        JSON.stringify(await f.service.view(id)),
        /追加した指示も保持してください/,
      );
      const requests = (await f.service.conversation(id)).requests;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal((await f.service.conversation(id)).requests, requests);
      assert.equal(
        (await f.service.download(id, "outputs/effects.txt")).toString(),
        "effect",
      );
      await f.service.send(id, randomUUID(), "", true);
      await until(
        async () => (await f.service.conversation(id)).status === "idle",
      );
      assert.equal(
        (await f.service.download(id, "outputs/effects.txt")).toString(),
        "effect",
      );
      assert.match(
        JSON.stringify(await f.service.view(id)),
        /更新は繰り返していません/,
      );
    } finally {
      await f.service.close();
    }
  } finally {
    child.kill("SIGKILL");
    if (shellPid) {
      try {
        process.kill(-shellPid, "SIGKILL");
      } catch {}
    }
  }
});
