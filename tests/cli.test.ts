import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess, cleanEnvironment } from "../src/process.js";
import { Conversations } from "../src/conversations.js";
import { paths } from "../src/config.js";
import { Store } from "../src/storage.js";

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
    const removalPreview = await command("remove", run.id);
    assert.equal(removalPreview.code, 0, removalPreview.stderr);
    assert.deepEqual(JSON.parse(removalPreview.stdout).runIds, [run.id]);
    assert.equal(
      JSON.parse((await command("status", run.id)).stdout).run.state,
      "cancelled",
    );
    const removal = await command("remove", run.id, "--write");
    assert.equal(removal.code, 0, removal.stderr);
    assert.equal(JSON.parse(removal.stdout).metadataRemoved, true);
    assert.equal(JSON.parse(removal.stdout).cleanupComplete, true);
    assert.deepEqual(JSON.parse((await command("status")).stdout), []);
    assert.equal((await command("status", run.id)).code, 1);

    const sessionPrepared = await command(
      "run",
      "--prepare-only",
      "An offline session deletion",
    );
    const sessionRun = JSON.parse(sessionPrepared.stdout).run;
    assert.equal((await command("cancel", sessionRun.id)).code, 0);
    assert.equal((await command("resume", sessionRun.id)).code, 130);
    const sessionStore = new Store(paths(home));
    const conversations = new Conversations(sessionStore);
    const session = conversations.create(home, {
      dataClass: "private",
      checks: [],
    });
    conversations.link(session, sessionStore.get(sessionRun.id));
    conversations.release(session.id);
    sessionStore.close();
    const sessionPreview = await command("remove-session", session.id);
    assert.equal(sessionPreview.code, 0, sessionPreview.stderr);
    assert.deepEqual(JSON.parse(sessionPreview.stdout).conversationIds, [
      session.id,
    ]);
    assert.ok(JSON.parse((await command("status", sessionRun.id)).stdout).run);
    const sessionRemoval = await command(
      "remove-session",
      session.id,
      "--write",
    );
    assert.equal(sessionRemoval.code, 0, sessionRemoval.stderr);
    assert.equal(JSON.parse(sessionRemoval.stdout).metadataRemoved, true);

    const prune = await command("prune");
    assert.equal(prune.code, 0, prune.stderr);
    assert.equal(JSON.parse(prune.stdout).written, false);
    const cleanupList = await command("cleanup-deletions");
    assert.equal(cleanupList.code, 0, cleanupList.stderr);
    assert.equal(JSON.parse(cleanupList.stdout).written, false);
    assert.equal((await command("cleanup-deletions", "--write")).code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
