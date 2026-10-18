import assert from "node:assert/strict";
import test from "node:test";
import { cleanEnvironment, runProcess } from "../src/process.js";

test("runProcess drops only an incomplete UTF-8 suffix when output is truncated", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('あい')"],
    { env: cleanEnvironment, maxBytes: 4, timeoutMs: 5000 },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "あ");
  assert.ok(Buffer.byteLength(result.stdout) <= 4);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.stdout, /�/);
});

test("runProcess tracks truncation independently for stdout and stderr", async () => {
  const result = await runProcess(
    process.execPath,
    ["-e", "process.stdout.write('ok'); process.stderr.write('あ')"],
    { env: cleanEnvironment, maxBytes: 2, timeoutMs: 5000 },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "");
  assert.equal(result.truncated, true);
});
