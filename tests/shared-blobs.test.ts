import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { access, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pinSharedBlobs, readSharedBlobPins } from "../src/shared-blobs.js";
import {
  confirmCacheCleanup,
  previewCacheCleanup,
} from "../src/cache-cleanup.js";
import { fixture, ScriptedRuntime } from "./helpers.js";

test("shared blob pins persist for the process lifetime and reject unknown names", async () => {
  const f = await fixture(new ScriptedRuntime(async () => ""));
  try {
    const path = `images/${"b".repeat(64)}.img`;
    await pinSharedBlobs(f.p, [path]);
    const pins = await readSharedBlobPins(f.p);
    assert.equal(pins.length, 1);
    assert.deepEqual(pins[0]?.paths, [path]);
    await assert.rejects(
      pinSharedBlobs(f.p, ["../outside"]),
      (error: { code?: string }) => error.code === "UNSAFE_STORAGE",
    );
  } finally {
    await f.cleanup();
  }
});

test("a child-process lifetime pin rendezvous blocks cache cleanup", async () => {
  const f = await fixture(new ScriptedRuntime(async () => ""));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const relative = `images/${"c".repeat(64)}.img`;
    const blob = join(f.p.home, relative);
    const ready = join(f.root, "child-ready");
    await mkdir(join(f.p.home, "images"), { mode: 0o700 });
    await writeFile(blob, "old orphan", { mode: 0o600 });
    const old = new Date(Date.now() - 2 * 86_400_000);
    await utimes(blob, old, old);
    const preview = await previewCacheCleanup(f.store, f.config, {
      kind: "eligible",
      paths: [],
    });
    const moduleUrl = new URL("../src/shared-blobs.js", import.meta.url).href;
    const script = `
      import { writeFile } from "node:fs/promises";
      import { pinSharedBlobs } from ${JSON.stringify(moduleUrl)};
      const paths = JSON.parse(process.argv[1]);
      await pinSharedBlobs(paths, [process.argv[2]]);
      await writeFile(process.argv[3], "ready");
      process.once("SIGTERM", () => process.exit(0));
      setInterval(() => {}, 1000);
    `;
    child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        script,
        JSON.stringify(f.p),
        relative,
        ready,
      ],
      { stdio: "ignore" },
    );
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        await access(ready);
        break;
      } catch {
        if (child.exitCode !== null)
          throw new Error("child pin writer exited before rendezvous");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await access(ready);
    await assert.rejects(confirmCacheCleanup(f.store, f.config, preview), {
      code: "STALE_VIEW",
    });
    const pinned = await previewCacheCleanup(f.store, f.config, {
      kind: "eligible",
      paths: [],
    });
    assert.ok(!pinned.selected.some((item) => item.path === relative));
    assert.ok(pinned.retained.some((item) => item.path === relative));
    child.kill("SIGTERM");
    await new Promise<void>((resolve, reject) => {
      child!.once("exit", () => resolve());
      child!.once("error", reject);
    });
    child = undefined;
    const unpinned = await previewCacheCleanup(f.store, f.config, {
      kind: "eligible",
      paths: [],
    });
    assert.ok(unpinned.selected.some((item) => item.path === relative));
    const result = await confirmCacheCleanup(f.store, f.config, unpinned);
    assert.deepEqual(result.pending, []);
    await assert.rejects(access(blob));
  } finally {
    child?.kill("SIGKILL");
    await rm(join(f.root, "child-ready"), { force: true });
    await f.cleanup();
  }
});
