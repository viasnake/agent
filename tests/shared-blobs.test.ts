import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import {
  pinSharedBlobs,
  readSharedBlobPins,
  previewPinCleanup,
  confirmPinCleanup,
  withSharedBlobLock,
} from "../src/shared-blobs.js";
import {
  confirmCacheCleanup,
  previewCacheCleanup,
} from "../src/cache-cleanup.js";
import { fixture, ScriptedRuntime } from "./helpers.js";

function exitedPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  return child.pid;
}
async function savedPin(
  home: string,
  pid: number,
  paths: string[] = [],
): Promise<string> {
  const processUuid = randomUUID();
  const file = `${pid}-${processUuid}.json`;
  await mkdir(join(home, "shared-blob-pins"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, "shared-blob-pins", file),
    JSON.stringify({ version: 1, pid, processUuid, paths }),
    { mode: 0o600 },
  );
  return file;
}

test("pin metadata cleanup holds live and invalid records and removes only verified dead metadata", async () => {
  const f = await fixture(
    new ScriptedRuntime(async () => assert.fail("No inference")),
  );
  try {
    const relative = `images/${"c".repeat(64)}.img`;
    await mkdir(join(f.p.home, "images"), { mode: 0o700 });
    await writeFile(join(f.p.home, relative), "retain original bytes", {
      mode: 0o600,
    });
    await pinSharedBlobs(f.p, [relative]);
    const live = (await readSharedBlobPins(f.p))[0]!.file;
    const dead = await savedPin(f.p.home, exitedPid(), [relative]);
    const directory = join(f.p.home, "shared-blob-pins");
    const temporary = `${dead}.${randomUUID()}.tmp`;
    await writeFile(join(directory, temporary), '{"interrupted":', {
      mode: 0o600,
    });
    const corrupt = await savedPin(f.p.home, exitedPid());
    await writeFile(join(directory, corrupt), "invalid");
    const alias = `${exitedPid()}-${randomUUID()}.json`;
    await symlink(join(f.p.home, relative), join(directory, alias));
    const preview = await previewPinCleanup(f.p);
    assert.deepEqual(
      preview.selected.map((item) => item.file).sort(),
      [dead, temporary].sort(),
    );
    assert.deepEqual(
      preview.retained.map((item) => item.file).sort(),
      [alias, corrupt, live].sort(),
    );
    await access(join(directory, dead));
    const result = await confirmPinCleanup(
      f.p,
      preview,
      new AbortController().signal,
    );
    assert.deepEqual(result.removed.sort(), [dead, temporary].sort());
    assert.deepEqual(result.pending, []);
    assert.equal(result.syncFailed, false);
    assert.equal(
      await readFile(join(f.p.home, relative), "utf8"),
      "retain original bytes",
    );
    for (const file of [alias, corrupt, live])
      await access(join(directory, file));
    await assert.rejects(access(join(directory, dead)));
    await assert.rejects(previewPinCleanup(f.p, ["../escape"]));
  } finally {
    await f.cleanup();
  }
});

test("pin cleanup rechecks content and liveness, observes cancellation under its lock, and reports partial work", async () => {
  const f = await fixture(new ScriptedRuntime(async () => ""));
  const kill = process.kill;
  try {
    const pid = exitedPid();
    const file = await savedPin(f.p.home, pid);
    const path = join(f.p.home, "shared-blob-pins", file);
    const preview = await previewPinCleanup(f.p, [file]);
    process.kill = ((candidate, signal) => {
      if (candidate === pid)
        throw Object.assign(new Error("permission unknown"), { code: "EPERM" });
      return kill.call(process, candidate, signal);
    }) as typeof process.kill;
    assert.equal((await previewPinCleanup(f.p, [file])).blocked, true);
    await assert.rejects(
      confirmPinCleanup(f.p, preview, new AbortController().signal),
      { code: "STALE_VIEW" },
    );
    process.kill = kill;
    await writeFile(path, (await readFile(path, "utf8")) + "\n");
    await assert.rejects(
      confirmPinCleanup(f.p, preview, new AbortController().signal),
      { code: "STALE_VIEW" },
    );
    const first = await previewPinCleanup(f.p, [file]);
    let release!: () => void, ready!: () => void;
    const acquired = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const held = withSharedBlobLock(f.p, async () => {
      ready();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await acquired;
    const control = new AbortController();
    const waiting = confirmPinCleanup(f.p, first, control.signal);
    const rejected = assert.rejects(waiting);
    control.abort();
    release();
    await held;
    await rejected;
    await access(path);
    const other = await savedPin(f.p.home, pid);
    const both = await previewPinCleanup(f.p, [file, other]);
    const partial = new AbortController();
    let guardCalls = 0;
    const result = await confirmPinCleanup(f.p, both, partial.signal, () => {
      if (++guardCalls === 3) partial.abort();
    });
    assert.deepEqual(result.removed, [both.selected[0]!.file]);
    assert.deepEqual(
      result.pending.map((item) => item.file),
      [both.selected[1]!.file],
    );
    await access(join(f.p.home, "shared-blob-pins", result.pending[0]!.file));
    const retry = await previewPinCleanup(
      f.p,
      result.pending.map((item) => item.file),
    );
    assert.equal(
      (await confirmPinCleanup(f.p, retry, new AbortController().signal))
        .removed.length,
      1,
    );
  } finally {
    process.kill = kill;
    await f.cleanup();
  }
});

test("dead pin cleanup recovers ordinary pin updates after accumulated metadata exceeds their bound", async () => {
  const f = await fixture(new ScriptedRuntime(async () => ""));
  try {
    const path = `images/${"a".repeat(64)}.img`;
    await pinSharedBlobs(f.p, [path]);
    const pid = exitedPid();
    const oldPaths = Array.from(
      { length: 5000 },
      (_, index) => `images/${index.toString(16).padStart(64, "0")}.img`,
    ).sort();
    const dead: string[] = [];
    for (let index = 0; index < 21; index++)
      dead.push(await savedPin(f.p.home, pid, oldPaths));
    await assert.rejects(pinSharedBlobs(f.p, [path]), { code: "DELETE_LIMIT" });
    const preview = await previewPinCleanup(f.p, dead);
    assert.equal(preview.selected.length, 21);
    assert.equal(preview.blocked, false);
    const result = await confirmPinCleanup(
      f.p,
      preview,
      new AbortController().signal,
    );
    assert.equal(result.removed.length, 21);
    assert.deepEqual(result.pending, []);
    await pinSharedBlobs(f.p, [path]);
    assert.equal((await readSharedBlobPins(f.p)).length, 1);
  } finally {
    await f.cleanup();
  }
});

test("pin cleanup CLI previews by default and explicitly removes only named metadata", async () => {
  const f = await fixture(new ScriptedRuntime(async () => ""));
  try {
    await writeFile(f.p.config, stringify(f.config), { mode: 0o600 });
    const file = await savedPin(f.p.home, exitedPid());
    const untouched = await savedPin(f.p.home, exitedPid());
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const command = (...args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [cli, "--home", f.p.home, "--json", "prune-pins", file, ...args],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    assert.equal(command().written, false);
    await access(join(f.p.home, "shared-blob-pins", file));
    const result = command("--write");
    assert.deepEqual(result.removed, [file]);
    assert.equal(result.cleanupComplete, true);
    await access(join(f.p.home, "shared-blob-pins", untouched));
    await assert.rejects(access(join(f.p.home, "shared-blob-pins", file)));
  } finally {
    await f.cleanup();
  }
});

test("pin discovery reports bounded directory pages rather than a total count", async () => {
  const f = await fixture(new ScriptedRuntime(async () => ""));
  try {
    const pid = exitedPid();
    for (let index = 0; index < 501; index++) await savedPin(f.p.home, pid);
    const first = await previewPinCleanup(f.p);
    assert.equal(first.scanned, 500);
    assert.equal(first.nextOffset, 500);
    const second = await previewPinCleanup(f.p, [], first.nextOffset);
    assert.equal(second.scanned, 1);
    assert.equal(second.nextOffset, undefined);
    assert.equal(
      new Set([...first.selected, ...second.selected].map((item) => item.file))
        .size,
      501,
    );
    assert.equal((await readSharedBlobPins(f.p)).length, 501);
  } finally {
    await f.cleanup();
  }
});

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
