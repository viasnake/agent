import { strict as assert } from "node:assert";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  confirmCacheCleanup,
  previewCacheCleanup,
} from "../src/cache-cleanup.js";
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
