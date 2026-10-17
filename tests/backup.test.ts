import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  lstat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { stringify } from "yaml";
import sharp from "sharp";
import { Application } from "../src/application.js";
import { createBackup, previewBackup, verifyBackup } from "../src/backup.js";
import { captureBoundary, persistBoundary } from "../src/branching.js";
import { Conversations } from "../src/conversations.js";
import { storePreparedText } from "../src/documents.js";
import { saveImage } from "../src/images.js";
import { BackupBrowser, backupPreviewText } from "../src/tui/backup-browser.js";
import { commands } from "../src/tui/actions.js";
import { fixture, gitWorkspace, ScriptedRuntime } from "./helpers.js";

async function backupFixture() {
  const runtime = new ScriptedRuntime(async () =>
    assert.fail("Backup must not infer"),
  );
  const f = await fixture(runtime);
  await writeFile(f.p.config, stringify(f.config), { mode: 0o600 });
  await writeFile(
    join(f.p.home, "terminal.json"),
    '{"schemaVersion":1,"keys":{}}',
    { mode: 0o600 },
  );
  const origin = await gitWorkspace(f.root, { "main.txt": "baseline\n" });
  const app = new Application(f.config, f.p, f.store, origin, async () =>
    assert.fail("Backup must not create a runtime"),
  );
  await app.initialize();
  const run = await f.harness.create({
    objective: "保存済み作業",
    kind: "coding",
    workspace: origin,
    conversationId: app.session.id,
    access: "change",
    checks: [],
  });
  app.conversations.link(app.session, run);
  const owned = f.store.claim(run.id, true);
  const source = await f.store.artifact(
    owned,
    "source.txt",
    "source",
    "保存済みの出典",
  );
  await f.store.artifact(owned, "report.md", "document", "根拠を持つ文書");
  f.store.release(owned);
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const image = await saveImage(f.p, "image.png", png, "restricted", true);
  const document = await storePreparedText(
    f.p,
    "sample.csv",
    "csv",
    "",
    Buffer.from("value\n9007199254740993\n"),
    "value\n9007199254740993\n",
    "lines 1-2",
    false,
  );
  app.session.workRunId = run.id;
  app.session.latestRunId = run.id;
  app.session.images = [image];
  app.session.dataClass = "restricted";
  app.session.localOnly = true;
  app.session.draft = "未送信の日本語";
  app.session.queue = [
    {
      id: "pending",
      text: "次の資料",
      mode: "next",
      documents: [document.reference],
    },
  ];
  app.session.context!.sourceIds = [source.id];
  await writeFile(
    join(f.store.runDir(run.id), "work/main.txt"),
    "historical work\n",
  );
  const boundary = await captureBoundary(
    f.p,
    f.config,
    f.store,
    app.session,
    0,
    undefined,
    { visibleRunIds: [run.id] },
  );
  const seq = app.conversations.message(
    app.session,
    "assistant",
    "境界の本文",
    run.id,
  );
  persistBoundary(f.store, boundary, seq);
  app.save();
  assert.equal(boundary.stateAvailable, true);
  await writeFile(
    join(f.store.runDir(run.id), "work/main.txt"),
    "uncommitted later work\n",
  );
  await writeFile(
    join(f.p.auth, "do-not-export.json"),
    "synthetic-credential-marker",
    { mode: 0o600 },
  );
  await writeFile(`${f.p.config}.bak`, "obsolete-config-marker", {
    mode: 0o600,
  });
  const otherWorkspace = join(f.root, "other-workspace");
  await mkdir(otherWorkspace);
  const conversations = new Conversations(f.store);
  const other = conversations.create(otherWorkspace, {
    dataClass: "private",
    checks: [],
  });
  conversations.message(other, "user", "別プロジェクトの保存済み本文");
  conversations.release(other.id);
  let closed = false;
  const closeApp = async () => {
    if (!closed) {
      await app.close();
      closed = true;
    }
  };
  return {
    ...f,
    app,
    run,
    source,
    image,
    document,
    boundary,
    runtime,
    owner: { sessionId: app.session.id, owner: app.conversations.owner },
    target: join(f.root, "history-backup"),
    closeApp,
    close: async () => {
      await closeApp();
      await f.cleanup();
    },
  };
}

test("logical backup preserves WAL history, images, documents, boundaries and policy without credentials or live work", async () => {
  const f = await backupFixture();
  try {
    const sessionBefore = JSON.stringify(f.app.session);
    const runBefore = JSON.stringify(f.store.get(f.run.id));
    const preview = f.app.previewHistoryBackup(f.target);
    assert.equal(preview.conversations, 2);
    assert.equal(preview.runs, 1);
    assert.equal(existsSync(f.target), false);
    const manifest = await f.app.confirmHistoryBackup(preview);
    assert.deepEqual(verifyBackup(f.target), manifest);
    assert.equal((await lstat(f.target)).mode & 0o777, 0o700);
    for (const file of manifest.files) {
      assert.equal(
        (await lstat(join(f.target, file.path))).mode & 0o777,
        0o600,
      );
      assert.doesNotMatch(file.path, /auth|\/work\/|sessions|\.bak$/);
    }
    assert.ok(
      manifest.files.some(
        (file) => file.path === `files/images/${f.image.sha256}.img`,
      ),
    );
    assert.ok(
      manifest.files.some(
        (file) =>
          file.path === `files/attachments/${f.document.reference.id}.selected`,
      ),
    );
    const snapshots = manifest.files.filter((file) =>
      file.path.startsWith("files/checkpoints/blobs/"),
    );
    assert.ok(
      (
        await Promise.all(
          snapshots.map((file) => readFile(join(f.target, file.path), "utf8")),
        )
      ).includes("historical work\n"),
    );
    const db = new DatabaseSync(join(f.target, "metadata.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM conversations").get()!.n,
        2,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM artifacts").get()!.n,
        2,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM boundaries").get()!.n,
        1,
      );
      const saved = JSON.parse(
        String(
          db
            .prepare("SELECT payload FROM conversations WHERE id=?")
            .get(f.app.session.id)!.payload,
        ),
      );
      assert.equal(saved.localOnly, true);
      assert.equal(saved.dataClass, "restricted");
      assert.equal(saved.draft, "未送信の日本語");
      assert.equal(
        saved.queue[0].documents[0].rawSha256,
        f.document.reference.rawSha256,
      );
    } finally {
      db.close();
    }
    const combined = Buffer.concat(
      await Promise.all(
        manifest.files.map((file) => readFile(join(f.target, file.path))),
      ),
    ).toString();
    assert.ok(!combined.includes("synthetic-credential-marker"));
    assert.ok(!combined.includes("obsolete-config-marker"));
    assert.ok(!combined.includes("uncommitted later work"));
    assert.equal(JSON.stringify(f.app.session), sessionBefore);
    assert.equal(JSON.stringify(f.store.get(f.run.id)), runBefore);
    assert.equal(f.runtime.requests.length, 0);
    const imagePath = `files/images/${f.image.sha256}.img`;
    await writeFile(
      join(f.target, "backup.json"),
      JSON.stringify({
        ...manifest,
        files: manifest.files.filter((file) => file.path !== imagePath),
      }),
    );
    assert.throws(() => verifyBackup(f.target), /参照先/);
    await writeFile(join(f.target, "backup.json"), JSON.stringify(manifest));
    await writeFile(join(f.target, imagePath), "corrupt");
    assert.throws(() => verifyBackup(f.target));
  } finally {
    await f.close();
  }
});

test("backup rejects changed previews, live owners/leases, links, unsafe destinations and corrupt blobs without partial output", async () => {
  const f = await backupFixture();
  const options = { owner: f.owner };
  try {
    const stale = previewBackup(f.store, f.config, f.target, options);
    f.app.conversations.message(
      f.app.session,
      "user",
      "確認後に追加された本文",
    );
    await assert.rejects(createBackup(f.store, f.config, stale, options), {
      code: "STALE_VIEW",
    });
    assert.equal(existsSync(f.target), false);
    assert.throws(() => previewBackup(f.store, f.config, f.target), {
      code: "SESSION_BUSY",
    });
    const current = previewBackup(f.store, f.config, f.target, options);
    const owned = f.store.claim(f.run.id, true);
    await assert.rejects(createBackup(f.store, f.config, current, options), {
      code: "RUN_BUSY",
    });
    f.store.release(owned);
    assert.equal(existsSync(f.target), false);
    assert.throws(
      () =>
        previewBackup(
          f.store,
          f.config,
          join(f.app.workspace, "backup"),
          options,
        ),
      { code: "BACKUP_UNSAFE" },
    );
    assert.throws(
      () => previewBackup(f.store, f.config, join(f.p.home, "backup"), options),
      { code: "BACKUP_UNSAFE" },
    );
    assert.throws(
      () =>
        previewBackup(f.store, f.config, f.target, {
          ...options,
          limits: { maxBytes: 1000 },
        }),
      { code: "BACKUP_LIMIT" },
    );
    const imagePath = join(f.p.home, "images", `${f.image.sha256}.img`);
    const bytes = await readFile(imagePath);
    await rm(imagePath);
    await symlink(f.p.config, imagePath);
    assert.throws(() => previewBackup(f.store, f.config, f.target, options), {
      code: "BACKUP_UNSAFE",
    });
    await rm(imagePath);
    await writeFile(imagePath, bytes, { mode: 0o600 });
    const corrupt = previewBackup(f.store, f.config, f.target, options);
    await writeFile(imagePath, Buffer.alloc(bytes.length, 1));
    await assert.rejects(createBackup(f.store, f.config, corrupt, options), {
      code: "BACKUP_UNSAFE",
    });
    assert.equal(existsSync(f.target), false);
    assert.equal(f.store.db.isTransaction, false);
    await writeFile(imagePath, bytes);
    const final = previewBackup(f.store, f.config, f.target, options);
    await createBackup(f.store, f.config, final, options);
    const before = await readFile(join(f.target, "backup.json"));
    await assert.rejects(createBackup(f.store, f.config, final, options), {
      code: "EXISTS",
    });
    assert.deepEqual(await readFile(join(f.target, "backup.json")), before);
    assert.equal(f.runtime.requests.length, 0);
  } finally {
    await f.close();
  }
});

test("backup holds a writer guard and preserves unknown operations rather than replaying them", async () => {
  const f = await backupFixture();
  try {
    f.store.db
      .prepare("INSERT INTO operations VALUES (?,?,?,?,?,?,?,?)")
      .run(
        "unknown-op",
        f.run.id,
        f.run.generation,
        "worker",
        "external_write",
        "hash",
        "unknown",
        null,
      );
    const preview = previewBackup(f.store, f.config, f.target, {
      owner: f.owner,
    });
    let guarded = false;
    await createBackup(f.store, f.config, preview, {
      owner: f.owner,
      beforeCapture: () => {
        assert.equal(f.store.db.isTransaction, true);
        const concurrent = new DatabaseSync(f.p.database);
        try {
          concurrent.exec("PRAGMA busy_timeout=1");
          assert.throws(
            () =>
              concurrent
                .prepare(
                  "INSERT INTO messages(session_id,role,text,at) VALUES (?,'user','concurrent',0)",
                )
                .run(f.app.session.id),
            /locked/,
          );
          guarded = true;
        } finally {
          concurrent.close();
        }
      },
    });
    assert.equal(guarded, true);
    const db = new DatabaseSync(join(f.target, "metadata.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        db.prepare("SELECT status FROM operations WHERE id='unknown-op'").get()!
          .status,
        "unknown",
      );
      assert.equal(
        db
          .prepare("SELECT COUNT(*) AS n FROM messages WHERE text='concurrent'")
          .get()!.n,
        0,
      );
    } finally {
      db.close();
    }
    assert.equal(f.runtime.requests.length, 0);
  } finally {
    await f.close();
  }
});

test("backup TUI cancels every stage, rejects changed session state, and explicitly saves without inference", async () => {
  const f = await backupFixture();
  try {
    assert.ok(commands.some((command) => command.name === "backup"));
    for (const stage of ["prompt", "preview", "confirm"]) {
      await new BackupBrowser(f.app, {
        prompt: async () => (stage === "prompt" ? undefined : f.target),
        show: async (text) => {
          assert.match(text, /全作業ディレクトリ/);
          assert.match(text, /暗号化は行いません/);
          return stage !== "preview";
        },
        confirm: async () => false,
        notice: () => assert.fail("Cancellation must not report success"),
      }).save();
      assert.equal(existsSync(f.target), false);
    }
    const preview = f.app.previewHistoryBackup(f.target);
    f.app.session.localOnly = false;
    await assert.rejects(f.app.confirmHistoryBackup(preview), {
      code: "STALE_VIEW",
    });
    assert.equal(existsSync(f.target), false);
    f.app.session.localOnly = true;
    f.app.save();
    let notice = "";
    await new BackupBrowser(f.app, {
      prompt: async () => f.target,
      show: async () => true,
      confirm: async () => true,
      notice: (text) => {
        notice = text;
      },
    }).save();
    assert.match(notice, /再開は行っていません/);
    assert.doesNotThrow(() => verifyBackup(f.target));
    assert.equal(f.app.busy, false);
    assert.equal(f.runtime.requests.length, 0);
    const text = backupPreviewText({
      ...preview,
      destination: "/safe/```\n# fake\u001b[31m",
    });
    assert.match(text, /````/);
    assert.ok(!text.includes("\u001b"));
  } finally {
    await f.close();
  }
});

test("backup CLI previews by default and verifies an explicit offline save without initializing another home", async () => {
  const f = await backupFixture();
  try {
    await f.closeApp();
    const cli = resolve(".test-dist/src/cli.js");
    const run = (...args: string[]) => {
      const result = spawnSync(process.execPath, [cli, "--json", ...args], {
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    assert.equal(run("--home", f.p.home, "backup", f.target).written, false);
    assert.equal(existsSync(f.target), false);
    assert.equal(
      run("--home", f.p.home, "backup", f.target, "--write").written,
      true,
    );
    const unusedHome = join(f.root, "must-not-initialize");
    assert.equal(
      run("--home", unusedHome, "backup-verify", f.target).valid,
      true,
    );
    assert.equal(existsSync(unusedHome), false);
  } finally {
    await f.close();
  }
});
