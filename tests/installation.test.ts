import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("an unavailable image decoder does not prevent loading the service", async (t) => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "sharp" || specifier === "./portable-image.js") {
        throw new Error("Image decoder unavailable");
      }
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

test("session output previews validate and return the original images when Sharp cannot load", async (t) => {
  const { default: sharp } = await import("sharp");
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        specifier === "sharp" &&
        context.parentURL?.endsWith("/src/images.js")
      ) {
        throw new Error("Sharp cannot load on this CPU");
      }
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const { fixture } = await import("./support.js");
  const { createServer } = await import("../src/server.js");
  const f = await fixture([], { noModel: true });
  const app = await createServer(f.service);
  t.after(async () => {
    await app.close();
    await f.service.close();
    await rm(f.root, { recursive: true });
  });
  const { id } = await f.service.create(randomUUID(), "Image previews");
  await f.service.upload(id, randomUUID(), "setup.txt", Buffer.from("fixture"));
  const headers: Record<string, string> = { host: "127.0.0.1:8080" };
  const session = await app.inject({ url: "/api/session", headers });
  headers.cookie = session.headers["set-cookie"]!.toString().split(";")[0]!;
  const image = (width: number) =>
    sharp({ create: { width, height: 8, channels: 3, background: "red" } });
  const preview = async (format: string, bytes: Buffer) => {
    const path = `outputs/diagram.${format}`;
    await writeFile(join(f.root, "work/conversations", id, path), bytes);
    return app.inject({
      url: `/api/conversations/${id}/file-image?path=${encodeURIComponent(path)}`,
      headers,
    });
  };
  for (const format of ["png", "jpeg", "webp"] as const) {
    const bytes = await image(2048)[format]().toBuffer();
    const response = await preview(format, bytes);
    assert.equal(response.statusCode, 200, format);
    assert.equal(response.headers["content-type"], `image/${format}`);
    assert.deepEqual(response.rawPayload, bytes);
  }
  assert.equal(
    (await preview("png", await image(2049).png().toBuffer())).statusCode,
    400,
  );
  const damaged = await image(8).png().toBuffer();
  damaged[damaged.indexOf("IDAT") + 4] = 0;
  assert.equal((await preview("png", damaged)).statusCode, 400);
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
