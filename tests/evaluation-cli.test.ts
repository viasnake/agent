import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess, cleanEnvironment } from "../src/process.js";

test("comparison CLI previews without inference and requires explicit run/assessment confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-comparison-cli-"));
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const home = join(root, "private-state");
  const command = (...args: string[]) =>
    runProcess(process.execPath, [cli, "--home", home, "--json", ...args], {
      env: cleanEnvironment,
      timeoutMs: 30000,
      maxBytes: 100000,
    });
  try {
    assert.equal((await command("init")).code, 0);
    const file = join(root, "suite.json");
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        name: "offline preview",
        repeats: 2,
        cases: [
          {
            id: "notice",
            kind: "writing",
            objective: "案内文を作成",
            inputs: ["facts.txt"],
          },
        ],
        variants: [
          { id: "single", mode: "single" },
          { id: "reviewed", mode: "reviewed" },
        ],
      }),
    );
    const preview = await command("eval-compare", "--suite", file);
    assert.equal(preview.code, 0, preview.stderr);
    const parsed = JSON.parse(preview.stdout);
    assert.equal(parsed.inferenceStarted, false);
    assert.equal(parsed.prepared, true);
    assert.equal(parsed.schedule.length, 4);
    assert.equal(parsed.suite.cases[0].inputs[0], join(root, "facts.txt"));
    assert.equal(
      parsed.configuredMaximum.requests,
      parsed.perRun.maxRequests * 4,
    );
    assert.deepEqual(JSON.parse((await command("status")).stdout), []);
    const conflicting = await command(
      "eval-compare",
      "--suite",
      file,
      "--prepare-only",
      "--confirm-run",
    );
    assert.equal(conflicting.code, 1);
    assert.match(conflicting.stderr, /Choose --prepare-only or --confirm-run/);
    assert.equal(
      (await command("eval-assess", "none", "none", "--assessment", file)).code,
      1,
    );
    assert.equal((await command("eval-report", "../outside")).code, 1);
    assert.deepEqual(JSON.parse((await command("status")).stdout), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
