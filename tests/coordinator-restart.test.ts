import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixture, answer, until } from "./support.js";

for (const phase of ["queued", "running", "reported"])
  test(`SIGKILL at ${phase} boundary preserves internal delivery without replaying uncertain work`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-coordinator-crash-"));
    const child = spawn(
      process.execPath,
      [resolve(".test-dist/tests/coordinator-restart-child.js"), root, phase],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let errors = "";
    child.stderr.on("data", (bytes: Buffer) => {
      errors += bytes.toString();
    });
    let shellPid: number | undefined;
    try {
      await until(async () => {
        if (child.exitCode !== null)
          throw new Error(errors || "fixture exited");
        return readFile(join(root, "ready.json")).then(
          () => true,
          () => false,
        );
      });
      const ids = JSON.parse(
        await readFile(join(root, "ready.json"), "utf8"),
      ) as { parentId: string; childId: string };
      if (phase === "running")
        shellPid = Number(
          await readFile(
            join(root, "work/conversations", ids.childId, "shell.pid"),
            "utf8",
          ),
        );
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
      if (shellPid) {
        try {
          process.kill(-shellPid, "SIGKILL");
        } catch {}
      }
      const reopened = await fixture(
        Array.from({ length: 12 }, () =>
          answer("状態を確認しました。外部操作を再送しません"),
        ),
        { root },
      );
      try {
        await until(
          async () =>
            !reopened.service.busy &&
            !(await reopened.service.coordinator.state()).commands.length &&
            !(await reopened.service.coordinator.state()).events.length,
        );
        const work = await reopened.service.conversation(ids.childId);
        assert.equal((await reopened.service.list()).length, 2);
        if (phase === "running") {
          assert.equal(work.status, "interrupted");
          assert.equal(work.paused, true);
          assert.equal(
            (
              await reopened.service.download(
                ids.childId,
                "outputs/effects.txt",
              )
            ).toString(),
            "effect",
          );
        } else {
          assert.equal(work.status, "idle");
          assert.equal(work.requests, 1);
        }
        if (phase === "reported")
          assert.equal(
            reopened.faux.state.callCount,
            0,
            "a committed notification answer is not delivered twice",
          );
        const calls = reopened.faux.state.callCount;
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(
          reopened.faux.state.callCount,
          calls,
          "idle does not poll a model",
        );
      } finally {
        await reopened.service.close();
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
