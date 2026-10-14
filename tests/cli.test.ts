import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess, cleanEnvironment } from "../src/process.js";

test("installed CLI initializes, prepares, cancels, resumes and removes an offline run", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-cli-"));
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const home = join(root, "Application Support", "Local Agent");
  const command = (...args: string[]) =>
    runProcess(process.execPath, [cli, "--home", home, "--json", ...args], {
      env: cleanEnvironment,
      timeoutMs: 30000,
      maxBytes: 100000,
    });
  try {
    assert.equal((await command("init")).code, 0);
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.equal((await stat(join(home, "config.yaml"))).mode & 0o777, 0o600);
    assert.ok(
      (await readFile(join(home, "config.yaml"), "utf8")).includes(
        "maxApiUsd: 0",
      ),
    );
    assert.equal((await command("config", "validate")).code, 0);
    const prepared = await command(
      "run",
      "--prepare-only",
      "An offline CLI lifecycle",
    );
    assert.equal(prepared.code, 0, prepared.stderr);
    const run = JSON.parse(prepared.stdout).run;
    assert.equal(run.state, "created");
    assert.equal((await command("cancel", run.id)).code, 0);
    assert.equal((await command("resume", run.id)).code, 130);
    const current = JSON.parse((await command("status", run.id)).stdout);
    assert.equal(current.run.state, "cancelled");
    assert.equal(current.usage.requests, 0);
    assert.equal((await command("remove", run.id)).code, 0);
    assert.deepEqual(JSON.parse((await command("status")).stdout), []);
    assert.equal((await command("status", run.id)).code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
