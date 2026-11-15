import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("entry point survives deletion, accepts input and monitors the replacement Harness", async (t) => {
  for (const mode of ["sigterm", "harness-close"]) {
    await t.test(mode, async () => {
      const root = await mkdtemp(join(tmpdir(), "agent-entry-point-"));
      const child = spawn(
        process.execPath,
        [
          "--experimental-test-module-mocks",
          fileURLToPath(new URL("./service-main-child.js", import.meta.url)),
          root,
          mode,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 20000,
          killSignal: "SIGKILL",
        },
      );
      const closed = once(child, "close");
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      try {
        const [code, signal] = await closed;
        assert.equal(signal, null, stderr);
        assert.match(stdout, /survivor-answered/, stderr);
        assert.equal(code, mode === "sigterm" ? 0 : 1, stderr);
      } finally {
        child.kill("SIGKILL");
        await closed;
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
