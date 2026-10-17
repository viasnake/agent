import { strict as assert } from "node:assert";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdir,
  rm,
  utimes,
  writeFile,
  symlink,
  readFile,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  confirmCacheCleanup,
  previewCacheCleanup,
  retryCacheCleanup,
  previewCacheCleanupJob,
  pendingCacheCleanups,
} from "../src/cache-cleanup.js";
import { pinSharedBlobs } from "../src/shared-blobs.js";
import { Conversations } from "../src/conversations.js";
import { createBackup, previewBackup, verifyBackup } from "../src/backup.js";
import { stringify } from "yaml";
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

async function oldBlob(
  f: Awaited<ReturnType<typeof fixture>>,
  relative: string,
) {
  const path = join(f.p.home, relative);
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, "old orphan", { mode: 0o600 });
  const old = new Date(Date.now() - 2 * 86_400_000);
  await utimes(path, old, old);
  return path;
}
async function failingUnlinks<T>(
  targets: string[],
  work: () => Promise<T>,
): Promise<T> {
  const original = fs.unlinkSync;
  fs.unlinkSync = ((path: fs.PathLike) => {
    if (targets.includes(String(path)))
      throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
    original(path);
  }) as typeof fs.unlinkSync;
  syncBuiltinESMExports();
  try {
    return await work();
  } finally {
    fs.unlinkSync = original;
    syncBuiltinESMExports();
  }
}

test("cache guards bind full metadata and reject ancestor symlinks and replaced files", async () => {
  const f = await fixture(new ScriptedRuntime(async () => ""));
  try {
    const relative = `checkpoints/blobs/${"1".repeat(64)}`;
    const blob = await oldBlob(f, relative);
    const request = { kind: "selection" as const, paths: [relative] };
    const preview = await previewCacheCleanup(f.store, f.config, request);
    await assert.rejects(
      confirmCacheCleanup(f.store, f.config, {
        ...preview,
        binding: "tampered",
      }),
      { code: "STALE_VIEW" },
    );
    f.store.db
      .prepare("INSERT INTO cooldowns(connection,until_ms) VALUES (?,?)")
      .run("unrelated-metadata-change", 1);
    await assert.rejects(confirmCacheCleanup(f.store, f.config, preview), {
      code: "STALE_VIEW",
    });
    const fresh = await previewCacheCleanup(f.store, f.config, request);
    await rm(blob);
    await oldBlob(f, relative);
    await assert.rejects(confirmCacheCleanup(f.store, f.config, fresh), {
      code: "STALE_VIEW",
    });
    const outside = join(f.root, "outside-checkpoints");
    fs.renameSync(f.p.checkpoints, outside);
    await symlink(outside, f.p.checkpoints);
    await assert.rejects(previewCacheCleanup(f.store, f.config, request), {
      code: "UNSAFE_STORAGE",
    });
    assert.equal(
      await readFile(join(outside, "blobs", "1".repeat(64)), "utf8"),
      "old orphan",
    );
  } finally {
    await f.cleanup();
  }
});

test("cache retry preserves replacement and late references and journals partial progress across retries", async () => {
  const f = await fixture(new ScriptedRuntime(async () => ""));
  try {
    const relatives = ["2", "3", "4"].map(
      (digit) => `images/${digit.repeat(64)}.img`,
    );
    const blobs = await Promise.all(relatives.map((path) => oldBlob(f, path)));
    const preview = await previewCacheCleanup(f.store, f.config, {
      kind: "selection",
      paths: relatives,
    });
    const failed = await failingUnlinks(blobs, () =>
      confirmCacheCleanup(f.store, f.config, preview),
    );
    const id = failed.pending[0]!.id;
    const retry = await previewCacheCleanupJob(f.store, f.config, id);
    await rm(blobs[1]!);
    await oldBlob(f, relatives[1]!);
    f.store.db
      .prepare("INSERT INTO cooldowns(connection,until_ms) VALUES (?,?)")
      .run("4".repeat(64), 1);
    await assert.rejects(confirmCacheCleanup(f.store, f.config, retry), {
      code: "STALE_VIEW",
    });
    const current = await previewCacheCleanupJob(f.store, f.config, id);
    assert.deepEqual(
      current.selected.map((entry) => entry.path),
      [relatives[0]],
    );
    assert.equal(current.retained.length, 2);
    const partial = await confirmCacheCleanup(f.store, f.config, current);
    assert.deepEqual(partial.removed, [relatives[0]]);
    assert.equal((await pendingCacheCleanups(f.p))[0]!.id, id);
    assert.equal(fs.existsSync(blobs[1]!), true);
    assert.equal(fs.existsSync(blobs[2]!), true);
    f.store.db.prepare("DELETE FROM cooldowns").run();
    const final = await retryCacheCleanup(f.store, f.config, id);
    assert.deepEqual(final.pending[0]!.paths, [relatives[1]]);
    assert.deepEqual((await pendingCacheCleanups(f.p))[0]!.paths, [
      relatives[1],
    ]);
    await rm(blobs[1]!);
    assert.deepEqual(
      (await retryCacheCleanup(f.store, f.config, id)).pending,
      [],
    );
    assert.deepEqual(await pendingCacheCleanups(f.p), []);
  } finally {
    await f.cleanup();
  }
});

test("cache cleanup fails closed for live and unresolved activity and empty selections", async () => {
  const f = await fixture(new ScriptedRuntime(async () => ""));
  try {
    const empty = await previewCacheCleanup(f.store, f.config, {
      kind: "eligible",
      paths: [],
    });
    await assert.rejects(confirmCacheCleanup(f.store, f.config, empty));
    assert.deepEqual(await pendingCacheCleanups(f.p), []);
    const relative = `images/${"5".repeat(64)}.img`;
    await oldBlob(f, relative);
    const request = { kind: "selection" as const, paths: [relative] };
    const conversations = new Conversations(f.store);
    const session = conversations.create(f.root, {
      dataClass: "private",
      checks: [],
    });
    await assert.rejects(previewCacheCleanup(f.store, f.config, request), {
      code: "SESSION_BUSY",
    });
    conversations.release(session.id);
    const run = await f.harness.create({
      kind: "research",
      objective: "guard fixture",
    });
    await assert.rejects(previewCacheCleanup(f.store, f.config, request), {
      code: "SESSION_BUSY",
    });
    const claimed = f.store.claim(run.id);
    f.store.transition(claimed, "succeeded");
    f.store.release(claimed);
    f.store.db
      .prepare("INSERT INTO operations VALUES (?,?,?,?,?,?,?,?)")
      .run(
        randomUUID(),
        run.id,
        claimed.generation,
        "worker",
        "write_file",
        "hash",
        "unknown",
        null,
      );
    await assert.rejects(previewCacheCleanup(f.store, f.config, request), {
      code: "SESSION_BUSY",
    });
    assert.equal(fs.existsSync(join(f.p.home, relative)), true);
  } finally {
    await f.cleanup();
  }
});

test("cache cleanup tolerates its own crash temp files, rejects malformed jobs and preserves backup verification", async () => {
  const f = await fixture(new ScriptedRuntime(async () => ""));
  try {
    const relative = `images/${"6".repeat(64)}.img`;
    await oldBlob(f, relative);
    const preview = await previewCacheCleanup(f.store, f.config, {
      kind: "selection",
      paths: [relative],
    });
    await confirmCacheCleanup(f.store, f.config, preview);
    const directory = join(f.p.home, "cache-cleanup-jobs");
    const temporary = `${randomUUID()}.json.${randomUUID()}.tmp`;
    await writeFile(join(directory, temporary), "incomplete", { mode: 0o600 });
    assert.deepEqual(await pendingCacheCleanups(f.p), []);
    const malformed = join(directory, `${randomUUID()}.json`);
    await writeFile(malformed, "null", { mode: 0o600 });
    await assert.rejects(pendingCacheCleanups(f.p), { code: "UNSAFE_STORAGE" });
    await rm(malformed);
    assert.deepEqual(await readdir(directory), [temporary]);
    await writeFile(f.p.config, stringify(f.config), { mode: 0o600 });
    const destination = join(f.root, "archive");
    await createBackup(
      f.store,
      f.config,
      previewBackup(f.store, f.config, destination),
    );
    await verifyBackup(destination);
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
