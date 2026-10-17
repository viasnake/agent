import { strict as assert } from "node:assert";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  confirmCacheCleanup,
  previewCacheCleanup,
  retryCacheCleanup,
} from "../src/cache-cleanup.js";
import { pinSharedBlobs } from "../src/shared-blobs.js";
import { fixture, ScriptedRuntime } from "./helpers.js";

test("shared cache cleanup is preview-first and removes only an explicitly confirmed old orphan", async () => {
  const f = await fixture(new ScriptedRuntime(async () => ""));
  try {
    const directory = join(f.p.home, "images");
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, `${"a".repeat(64)}.img`);
    await writeFile(path, "orphan", { mode: 0o600 });
    const old = new Date(Date.now() - 2 * 86_400_000);
    await utimes(path, old, old);
    const preview = await previewCacheCleanup(f.store, f.config, {
      kind: "eligible",
      paths: [],
    });
    assert.equal(preview.selected.length, 1);
    assert.ok(
      preview.request.cutoff! <= Date.now() - 86_400_000 &&
        preview.request.cutoff! > Date.now() - 86_400_000 - 1000,
    );
    assert.equal(preview.selected[0]?.path, `images/${"a".repeat(64)}.img`);
    await confirmCacheCleanup(f.store, f.config, preview);
    await assert.rejects(() =>
      import("node:fs/promises").then((fs) => fs.lstat(path)),
    );
  } finally {
    await f.cleanup();
  }
});

test("shared cache cleanup handles every known orphan blob format", async () => {
  const f = await fixture(new ScriptedRuntime(async () => ""));
  try {
    const digest = "f".repeat(64);
    await mkdir(join(f.p.home, "images"), { mode: 0o700 });
    await mkdir(join(f.p.home, "attachments"), { mode: 0o700 });
    await mkdir(join(f.p.home, "checkpoints", "blobs"), {
      recursive: true,
      mode: 0o700,
    });
    const paths = [
      `images/${digest}.img`,
      `attachments/${digest}.raw`,
      `attachments/doc-${digest}.selected`,
      `checkpoints/blobs/${digest}`,
    ];
    const old = new Date(Date.now() - 2 * 86_400_000);
    for (const relative of paths) {
      const path = join(f.p.home, relative);
      await writeFile(path, "orphan", { mode: 0o600 });
      await utimes(path, old, old);
    }
    const preview = await previewCacheCleanup(f.store, f.config, {
      kind: "eligible",
      paths: [],
    });
    assert.deepEqual(
      preview.selected.map((item) => item.path).sort(),
      paths.sort(),
    );
    const result = await confirmCacheCleanup(f.store, f.config, preview);
    assert.deepEqual(result.pending, []);
    for (const relative of paths)
      await assert.rejects(() =>
        import("node:fs/promises").then((fs) =>
          fs.lstat(join(f.p.home, relative)),
        ),
      );
  } finally {
    await f.cleanup();
  }
});

test("cache cleanup retains references and pins and rejects a stale preview", async () => {
  const f = await fixture(new ScriptedRuntime(async () => ""));
  try {
    const digest = "c".repeat(64);
    await mkdir(join(f.p.home, "images"), { mode: 0o700 });
    await writeFile(join(f.p.home, "images", `${digest}.img`), "orphan", {
      mode: 0o600,
    });
    const target = join(f.p.home, "images", `${"d".repeat(64)}.img`);
    await writeFile(target, "pinned", { mode: 0o600 });
    const old = new Date(Date.now() - 2 * 86_400_000);
    await utimes(join(f.p.home, "images", `${digest}.img`), old, old);
    await utimes(target, old, old);
    await pinSharedBlobs(f.p, [`images/${"d".repeat(64)}.img`]);
    const preview = await previewCacheCleanup(f.store, f.config, {
      kind: "eligible",
      paths: [],
    });
    assert.deepEqual(
      preview.selected.map((item) => item.path),
      [`images/${digest}.img`],
    );
    f.store.db
      .prepare("INSERT INTO cooldowns(connection,until_ms) VALUES (?,?)")
      .run(digest, Date.now());
    await assert.rejects(
      confirmCacheCleanup(f.store, f.config, preview),
      (error: { code?: string }) => error.code === "STALE_VIEW",
    );
  } finally {
    await f.cleanup();
  }
});

test("cache cleanup persists an unlink failure and retries after reopening", async () => {
  const f = await fixture(new ScriptedRuntime(async () => ""));
  const digest = "e".repeat(64);
  const path = join(f.p.home, "images", `${digest}.img`);
  let closed = false;
  try {
    await mkdir(join(f.p.home, "images"), { mode: 0o700 });
    await writeFile(path, "pending", { mode: 0o600 });
    const old = new Date(Date.now() - 2 * 86_400_000);
    await utimes(path, old, old);
    const preview = await previewCacheCleanup(f.store, f.config, {
      kind: "selection",
      paths: [`images/${digest}.img`],
    });
    const unlink = fs.unlinkSync;
    fs.unlinkSync = ((target: fs.PathLike) => {
      if (String(target) === path)
        throw Object.assign(new Error("forced unlink failure"), {
          code: "EACCES",
        });
      unlink(target);
    }) as typeof fs.unlinkSync;
    syncBuiltinESMExports();
    let result;
    try {
      result = await confirmCacheCleanup(f.store, f.config, preview);
    } finally {
      fs.unlinkSync = unlink;
      syncBuiltinESMExports();
    }
    assert.equal(result.pending.length, 1);
    const job = result.pending[0]!;
    f.store.close();
    closed = true;
    const { Store } = await import("../src/storage.js");
    const reopened = new Store(f.p);
    try {
      const retried = await retryCacheCleanup(reopened, f.config, job.id);
      assert.deepEqual(retried.pending, []);
    } finally {
      reopened.close();
    }
  } finally {
    if (closed) await rm(f.root, { recursive: true, force: true });
    else await f.cleanup();
  }
});
