import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  mkdir,
  writeFile,
  symlink,
  rename,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fixture, answer, call, until, TestRunner } from "./support.js";
import { AgentDoc } from "@earendil-works/pi-durable";
import { requestDeletion } from "../src/session-deletion.js";
import type { WorkerRequest } from "../src/execution/protocol.js";

test("purge removes old titles, text, images, memories and all workspace files while preserving unrelated data", async () => {
  let f = await fixture([answer("deleted-answer-unique-marker")]);
  const creation = randomUUID();
  const target = await f.service.create(
    creation,
    "deleted-title-unique-marker",
  );
  const keep = await f.service.create(randomUUID(), "survivor");
  await f.service.upload(
    keep.id,
    randomUUID(),
    "keep.txt",
    Buffer.from("keep"),
  );
  const base = join(f.root, "work/conversations", target.id);
  await f.service.upload(
    target.id,
    randomUUID(),
    "private.txt",
    Buffer.from("deleted-file-unique-marker"),
  );
  await writeFile(join(base, "root-file"), "private");
  await mkdir(join(base, "nested"));
  await symlink(
    join(f.root, "work/conversations", keep.id),
    join(base, "nested/link"),
  );
  await f.service.send(target.id, randomUUID(), "deleted-input-unique-marker");
  await until(
    async () => (await f.service.conversation(target.id)).status === "idle",
  );
  await f.service.renameConversation(
    target.id,
    "deleted-renamed-unique-marker",
  );
  const note = randomUUID();
  await f.service.memory.save({
    requestId: note,
    text: "deleted-memory-old-marker",
    source: { sessionId: target.id },
  });
  await f.service.memory.update(note, {
    revision: 1,
    text: "deleted-memory-new-marker",
  });
  await f.service.memory.save({
    requestId: randomUUID(),
    text: "surviving memory",
    source: { sessionId: keep.id },
  });
  const replay = {
    requestId: randomUUID(),
    text: "deleted-merged-memory-marker",
    source: { sessionId: keep.id },
  };
  await f.service.memory.save(replay);
  await f.service.memory.update(
    replay.requestId,
    { revision: 1, text: "deleted-merged-memory-new-marker" },
    { source: { sessionId: target.id } },
  );
  // Original admitted image bytes are also stored in Pi entries, independently of attachments/.
  const pi = await f.service.piConversation(target.id);
  await pi.submit(
    {
      type: "write",
      entry: {
        kind: "user",
        model: [
          {
            role: "user",
            timestamp: Date.now(),
            content: [
              {
                type: "image",
                mimeType: "image/png",
                data: "deleted-image-payload-marker",
              },
            ],
          },
        ],
      },
    },
    ctx,
  );
  const legacy = join(f.root, "control/state.sqlite");
  await writeFile(legacy, "legacy-preserved");
  try {
    await f.service.deleteConversation(target.id);
    await assert.rejects(f.service.memory.save(replay), { statusCode: 410 });
    await assert.rejects(stat(base), { code: "ENOENT" });
    assert.equal((await f.service.files(keep.id)).files!.length, 1);
    assert.deepEqual(
      (await f.service.memory.list()).map((item) => item.text),
      ["surviving memory"],
    );
    await f.service.close();
    const control = join(f.root, "control");
    for (const name of await readdir(control)) {
      const path = join(control, name);
      if (!(await stat(path)).isFile()) continue;
      assert.doesNotMatch(
        (await readFile(path)).toString(),
        /deleted-(?:title|renamed|input|answer|file|memory|image)-/,
      );
    }
    assert.equal(await readFile(legacy, "utf8"), "legacy-preserved");
    f = await fixture([answer("still usable")], { root: f.root });
    await assert.rejects(
      f.service.create(creation, "deleted-title-unique-marker"),
      { statusCode: 410 },
    );
    await f.service.deleteConversation(target.id);
    await f.service.send(keep.id, randomUUID(), "continue");
    await until(
      async () => (await f.service.conversation(keep.id)).status === "idle",
    );
    assert.match(JSON.stringify(await f.service.view(keep.id)), /still usable/);
  } finally {
    await f.service.close();
  }
});

test("purging a parent preserves only inherited fork history, allows new forks, and purges shared history after the last branch", async () => {
  let f = await fixture([
    call("write", { path: "outputs/shared.txt", content: "shared" }),
    answer("inherited-unique-marker"),
  ]);
  try {
    const parent = await f.service.create(randomUUID(), "parent");
    const inputRequest = randomUUID();
    await f.service.send(parent.id, inputRequest, "inherited-input-marker");
    await until(
      async () => (await f.service.conversation(parent.id)).status === "idle",
    );
    const entry = (await f.service.view(parent.id)).transcript.find((item) =>
      item.messages.some((message) =>
        message.content.includes("inherited-unique-marker"),
      ),
    )!;
    const first = await f.service.branch(
      parent.id,
      randomUUID(),
      entry.id,
      "fork",
    );
    const second = await f.service.branch(
      parent.id,
      randomUUID(),
      entry.id,
      "fork",
    );
    f.config.instructions = "not-inherited-config-marker";
    f.faux.setResponses([answer("not-inherited-private-marker")]);
    await f.service.send(parent.id, randomUUID(), "not-inherited-input-marker");
    await until(
      async () => (await f.service.conversation(parent.id)).status === "idle",
    );
    await f.service.deleteConversation(parent.id);
    for (const branch of [first, second])
      assert.match(
        JSON.stringify(await f.service.view(branch.id)),
        /inherited-unique-marker/,
      );
    const nested = await f.service.branch(
      first.id,
      randomUUID(),
      entry.id,
      "fork",
    );
    assert.doesNotMatch(
      JSON.stringify(
        await f.service.harness.snapshot(
          AgentDoc,
          (await f.service.conversation(nested.id)).piId,
          ctx,
        ),
      ),
      /not-inherited-config-marker/,
    );
    f.config.instructions = "";
    f.faux.setResponses([answer("branch response")]);
    const request = randomUUID();
    await f.service.send(nested.id, request, "branch input");
    await until(
      async () => (await f.service.conversation(nested.id)).status === "idle",
    );
    await f.service.close();
    assert.doesNotMatch(
      (
        await readFile(join(f.root, "control/conversations-v1.sqlite"))
      ).toString(),
      /not-inherited-(?:private|input|config)-marker/,
    );
    f = await fixture([], { root: f.root });
    await f.service.send(nested.id, request, "branch input");
    assert.match(
      JSON.stringify(await f.service.view(nested.id)),
      /branch response/,
    );
    for (const branch of [first, second, nested])
      await f.service.deleteConversation(branch.id);
    await f.service.close();
    assert.doesNotMatch(
      (
        await readFile(join(f.root, "control/conversations-v1.sqlite"))
      ).toString(),
      /inherited-(?:unique|input)-marker|branch input|branch response/,
    );
  } finally {
    await f.service.close();
  }
});

test("a failed deletion fails closed and restart completes the durable intent without inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-delete-"));
  class FailingRunner extends TestRunner {
    override async call(
      id: string,
      op: WorkerRequest["op"],
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ) {
      if (op === "delete_workspace") throw new Error("disk failure");
      return super.call(id, op, args, signal);
    }
  }
  let f = await fixture([], {
    root,
    runner: new FailingRunner(join(root, "work")),
  });
  const target = await f.service.create(randomUUID(), "delete on restart");
  await f.service.upload(
    target.id,
    randomUUID(),
    "file.txt",
    Buffer.from("delete me"),
  );
  await assert.rejects(f.service.deleteConversation(target.id), {
    statusCode: 503,
  });
  assert.equal(f.service.healthy(), false);
  await assert.rejects(f.service.create(randomUUID(), "blocked"), {
    statusCode: 503,
  });
  assert.ok(await readFile(join(root, "control/session-deletion.json")));
  await f.service.close();
  f = await fixture([], { root });
  try {
    assert.deepEqual(await f.service.list(), []);
    await assert.rejects(stat(join(root, "work/conversations", target.id)), {
      code: "ENOENT",
    });
    await assert.rejects(stat(join(root, "control/session-deletion.json")), {
      code: "ENOENT",
    });
    // Replay an intent left after the database replacement but before marker removal.
    await f.service.close();
    await requestDeletion(join(root, "control"), target.id);
    f = await fixture([], { root });
    assert.deepEqual(await f.service.list(), []);
  } finally {
    await f.service.close();
  }
});

test("workspace deletion unlinks session symlinks but refuses a replaced parent", async () => {
  const f = await fixture();
  try {
    const first = await f.service.create(randomUUID(), "first");
    const second = await f.service.create(randomUUID(), "second");
    const file = await f.service.upload(
      second.id,
      randomUUID(),
      "file",
      Buffer.from("keep"),
    );
    await symlink(
      join(f.root, "work/conversations", second.id),
      join(f.root, "work/conversations", first.id),
    );
    await f.service.deleteConversation(first.id);
    assert.equal(
      (await f.service.download(second.id, file.path)).toString(),
      "keep",
    );
    const parent = join(f.root, "work/conversations");
    await rename(parent, `${parent}-moved`);
    await symlink(`${parent}-moved`, parent);
    await assert.rejects(f.service.deleteConversation(second.id), {
      statusCode: 503,
    });
    assert.equal(
      await readFile(join(`${parent}-moved`, second.id, file.path), "utf8"),
      "keep",
    );
  } finally {
    await f.service.close();
  }
});
