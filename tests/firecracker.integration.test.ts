import test from "node:test";
import assert from "node:assert/strict";
import { FirecrackerEnvironment } from "../src/execution/firecracker.js";

const required = process.env.AGENT_REQUIRE_FIRECRACKER === "1";

test(
  "real Firecracker boot, disk persistence, command status, cancellation cleanup, and destroy",
  { skip: !required },
  async () => {
    const environment = new FirecrackerEnvironment();
    const diagnosis = await environment.diagnose();
    assert.equal(diagnosis.ok, true, JSON.stringify(diagnosis));

    const persistent = await environment.create();
    try {
      assert.equal((await environment.start(persistent.id)).state, "ready");
      const write = await environment.execute(persistent.id, {
        argv: ["/bin/sh", "-c", "printf firecracker-persisted > .agent-marker"],
        timeoutMs: 30_000,
        maxOutputBytes: 4096,
      });
      assert.equal(write.code, 0, JSON.stringify(write));
      await environment.stop(persistent.id);
      assert.equal((await environment.start(persistent.id)).state, "ready");
      const read = await environment.execute(persistent.id, {
        argv: ["/bin/cat", ".agent-marker"],
        timeoutMs: 30_000,
        maxOutputBytes: 4096,
      });
      assert.equal(read.stdout, "firecracker-persisted");
      const nonzero = await environment.execute(persistent.id, {
        argv: ["/bin/sh", "-c", "exit 7"],
        timeoutMs: 30_000,
        maxOutputBytes: 4096,
      });
      assert.equal(nonzero.code, 7);
    } finally {
      await environment.destroy(persistent.id);
    }

    const cancelled = await environment.create();
    try {
      await environment.start(cancelled.id);
      const controller = new AbortController();
      const execution = environment.execute(
        cancelled.id,
        {
          argv: ["/bin/sleep", "60"],
          timeoutMs: 120_000,
          maxOutputBytes: 4096,
        },
        controller.signal,
      );
      setTimeout(() => controller.abort(), 500).unref();
      await assert.rejects(execution);
      assert.equal((await environment.status(cancelled.id)).state, "failed");
    } finally {
      await environment.destroy(cancelled.id);
    }
  },
);
