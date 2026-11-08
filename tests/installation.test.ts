import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Linux flock refuses a duplicate writer before its command can touch SQLite", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-lock-")),
    lock = join(root, "writer.lock"),
    ready = join(root, "ready"),
    unexpected = join(root, "unexpected");
  const first = spawn("flock", [
    "-n",
    lock,
    process.execPath,
    "-e",
    `require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{},10000)`,
  ]);
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await readFile(ready);
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    }
    const result = spawnSync("flock", [
      "-n",
      "-E",
      "73",
      lock,
      process.execPath,
      "-e",
      `require('fs').writeFileSync(${JSON.stringify(unexpected)},'opened')`,
    ]);
    assert.equal(result.status, 73);
    await assert.rejects(readFile(unexpected));
    const main = await readFile("src/main.ts", "utf8");
    assert.ok(
      main.indexOf('"/usr/bin/flock"') < main.indexOf('"./service-main.js"'),
    );
  } finally {
    const exit = once(first, "exit");
    first.kill();
    await exit;
  }
});
