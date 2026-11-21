import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("an unavailable image decoder does not prevent loading the service", async (t) => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "sharp") throw new Error("Image decoder unavailable");
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const { AgentService } = await import("../src/service.js");
  assert.equal(typeof AgentService.open, "function");
  const { validateImage } = await import("../src/images.js");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7xkAAAAASUVORK5CYII=",
    "base64",
  );
  await assert.rejects(validateImage(png), { statusCode: 503 });
});

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
