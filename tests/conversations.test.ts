import { mcpToolName } from "../src/tools.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  symlink,
  link,
  mkdir,
  open,
  rename,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  fixture,
  answer,
  call,
  csvResponses,
  until,
  TestRunner,
} from "./support.js";
import { assertFileDescriptorPath } from "../src/execution/worker.js";

test("CSV and Markdown use unmodified Pi file/edit/bash tools, outputs are downloadable without registration, and an answered conversation continues", async () => {
  const { service, runner, root, faux } = await fixture(csvResponses());
  try {
    const request = randomUUID(),
      { id } = await service.create(request, "CSV を整形する");
    assert.equal((await service.create(request, "CSV を整形する")).id, id);
    await assert.rejects(service.create(request, "別の依頼"), /requestId/);
    const path = await service.upload(
      id,
      randomUUID(),
      "raw.csv",
      Buffer.from("name,total\n Alice , 12\nBob,3\n"),
    );
    const base = join(root, "work/conversations", id);
    await writeFile(
      join(base, "attachments/input.csv"),
      await readFile(join(base, path.path)),
    );
    const sendId = randomUUID();
    await service.send(id, sendId, "CSV を整形して CSV を返して");
    await until(async () => (await service.conversation(id)).status === "idle");
    assert.equal(
      (await service.files(id)).files![0]!.path,
      "outputs/clean.csv",
    );
    assert.equal(
      (await service.download(id, "outputs/clean.csv")).toString(),
      "name,total\nAlice,12\nBob,3\n",
    );
    const view = JSON.stringify(await service.view(id));
    assert.match(view, /CSV verified/);
    assert.doesNotMatch(view, /finish_job|publish_artifact/);
    await service.send(id, sendId, "CSV を整形して CSV を返して");
    await assert.rejects(service.send(id, sendId, "changed"), /requestId/);
    faux.setResponses([
      call("write", {
        path: "outputs/note.md",
        content: "# 手順\n\nCSV を読みます。\n",
      }),
      call("edit", {
        path: "outputs/note.md",
        edits: [{ oldText: "読みます", newText: "確認します" }],
      }),
      answer("Markdown を作成しました。PDF はありません。"),
    ]);
    await service.send(id, randomUUID(), "続けて Markdown の手順を作って");
    await until(async () => (await service.conversation(id)).status === "idle");
    assert.equal((await service.list()).length, 1);
    assert.match(
      (await service.download(id, "outputs/note.md")).toString(),
      /確認します/,
    );
    assert.equal((await service.files(id)).files!.length, 2);
    assert.ok(runner instanceof TestRunner);
  } finally {
    await service.close();
  }
});

test("busy is rejected without queueing; steering uses Pi inbox; stop reaps children and explicit resume retains the conversation", async () => {
  const { service, root, faux } = await fixture([
    call("bash", {
      command: "echo $$ > child.pid; printf ready > started; sleep 30",
    }),
    answer("stale"),
  ]);
  try {
    const { id } = await service.create(randomUUID(), "中断"),
      other = await service.create(randomUUID(), "別の会話");
    await service.send(id, randomUUID(), "待って");
    const base = join(root, "work/conversations", id);
    await until(async () =>
      readFile(join(base, "started")).then(
        () => true,
        () => false,
      ),
    );
    await assert.rejects(
      service.send(other.id, randomUUID(), "queued?"),
      /busy/,
    );
    await service.send(id, randomUUID(), "CSV の列名は変えないで");
    assert.equal((await service.view(id)).pendingInputs, 1);
    const pid = Number(await readFile(join(base, "child.pid"), "utf8"));
    await service.stop(id);
    assert.equal((await service.conversation(id)).status, "interrupted");
    assert.throws(() => process.kill(pid, 0));
    assert.match(
      JSON.stringify(await service.view(id)),
      /CSV の列名は変えないで/,
    );
    faux.setResponses([
      call("bash", { command: "test -f started && printf resumed" }),
      answer("再開しました"),
    ]);
    await service.send(id, randomUUID(), "", true);
    await until(async () => (await service.conversation(id)).status === "idle");
    assert.match(JSON.stringify(await service.view(id)), /resumed/);
    assert.equal((await service.conversation(other.id)).status, "idle");
  } finally {
    await service.close();
  }
});

test("command failures and dispatch/time limits do not claim guaranteed success or retry indefinitely", async () => {
  const f = await fixture([
    call("bash", { command: "printf expected-error; exit 7" }),
    answer("コマンドは失敗しました。"),
  ]);
  try {
    const { id } = await f.service.create(randomUUID(), "失敗");
    await f.service.send(id, randomUUID(), "実行");
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    assert.match(JSON.stringify(await f.service.view(id)), /expected-error/);
    assert.match(JSON.stringify(await f.service.view(id)), /7/);
    f.config.limits.modelRequests = 1;
    f.faux.setResponses([
      call("bash", { command: "printf once >> calls" }),
      answer("must be gated"),
    ]);
    await f.service.send(id, randomUUID(), "上限");
    await until(
      async () => (await f.service.conversation(id)).status === "interrupted",
    );
    assert.equal((await f.service.conversation(id)).requests, 1);
    f.config.limits.runSeconds = 1;
    f.faux.setResponses([
      call("bash", { command: "echo $$ > timed.pid; sleep 30" }),
    ]);
    await f.service.send(id, randomUUID(), "期限");
    await until(
      async () => (await f.service.conversation(id)).status === "interrupted",
    );
    assert.match((await f.service.conversation(id)).detail, /上限/);
  } finally {
    await f.service.close();
  }
});

test("restart preserves Pi history and work files, leaves legacy DB untouched, and never dispatches until explicit input", async () => {
  let f = await fixture([
    call("write", { path: "outputs/keep.txt", content: "retained" }),
    answer("保存"),
  ]);
  const { id } = await f.service.create(randomUUID(), "永続化");
  await f.service.send(id, randomUUID(), "保存");
  await until(async () => (await f.service.conversation(id)).status === "idle");
  await writeFile(join(f.root, "control/state.sqlite"), "legacy-do-not-open");
  await f.service.close();
  f = await fixture([answer("続き")], { root: f.root });
  try {
    assert.equal(
      (await readFile(join(f.root, "control/state.sqlite"))).toString(),
      "legacy-do-not-open",
    );
    assert.equal(
      (await f.service.download(id, "outputs/keep.txt")).toString(),
      "retained",
    );
    assert.match(JSON.stringify(await f.service.view(id)), /保存/);
    assert.equal((await f.service.conversation(id)).requests, 2);
    await f.service.send(id, randomUUID(), "続きをお願いします");
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    assert.match(JSON.stringify(await f.service.view(id)), /続き/);
  } finally {
    await f.service.close();
  }
});

test("configured stdio MCP tool is listed and called using the real official client and server", async () => {
  const f = await fixture([], {
    mcp: [
      {
        name: "fixture",
        command: process.execPath,
        args: [resolve(".test-dist/tests/mcp-server.js")],
      },
    ],
  });
  try {
    f.faux.setResponses([
      call(mcpToolName(f.service.settings.snapshot().mcp[0]!.id, "greet"), {
        name: "Pi",
      }),
      answer("挨拶しました"),
    ]);
    const { id } = await f.service.create(randomUUID(), "MCP");
    await f.service.send(id, randomUUID(), "挨拶");
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    assert.match(JSON.stringify(await f.service.view(id)), /Hello Pi/);
  } finally {
    await f.service.close();
  }
});

test("downloads reject traversal, absolute paths, symlinks, hardlinks, FIFO and oversized files; normal files need no registry", async () => {
  const { service, root } = await fixture();
  try {
    const { id } = await service.create(randomUUID(), "境界");
    await service.upload(id, randomUUID(), "init.txt", Buffer.from("init"));
    const base = join(root, "work/conversations", id);
    await writeFile(join(base, "outputs/good.csv"), "a,b\n1,2\n");
    await symlink("/etc/passwd", join(base, "outputs/link"));
    await mkdir(join(base, "outside"));
    await writeFile(join(base, "outside/private"), "secret");
    await symlink("../outside", join(base, "outputs/parent"));
    await link(join(base, "outside/private"), join(base, "outputs/hard"));
    assert.equal(spawnSync("mkfifo", [join(base, "outputs/pipe")]).status, 0);
    const large = await open(join(base, "outputs/large"), "w");
    await large.truncate(20971521);
    await large.close();
    for (const path of [
      "../outside/private",
      "/etc/passwd",
      "attachments/raw.csv",
      "outputs/link",
      "outputs/parent/private",
      "outputs/hard",
      "outputs/pipe",
      "outputs/large",
    ])
      await assert.rejects(service.download(id, path), path);
    assert.equal(
      (await service.download(id, "outputs/good.csv")).toString(),
      "a,b\n1,2\n",
    );
    assert.deepEqual(
      (await service.files(id)).files?.map((file) => file.path),
      ["outputs/good.csv"],
    );
    await assert.rejects(
      service.upload(id, randomUUID(), "big", Buffer.alloc(20971521)),
      /上限/,
    );
  } finally {
    await service.close();
  }
});

test("unconfigured models and unavailable workers refuse execution without losing history", async () => {
  const f = await fixture([], { noModel: true });
  try {
    const { id } = await f.service.create(randomUUID(), "モデルなし");
    assert.equal((await f.service.view(id)).modelConfigured, false);
    await assert.rejects(f.service.send(id, randomUUID(), "hello"), /モデル/);
    assert.equal((await f.service.list()).length, 1);
  } finally {
    await f.service.close();
  }
  const configured = await fixture([answer("must not run")]);
  try {
    (configured.runner as TestRunner).available = false;
    const { id } = await configured.service.create(
      randomUUID(),
      "Unavailable worker",
    );
    await assert.rejects(
      configured.service.send(id, randomUUID(), "hello"),
      /作業 UID・通信制限・子プロセスの回収を確認できません/,
    );
    assert.equal((await configured.service.conversation(id)).status, "idle");
    assert.equal((await configured.service.view(id)).transcript.length, 0);
  } finally {
    await configured.service.close();
  }
});

test("an opened file whose parent moved outside the expected path is refused", async () => {
  const f = await fixture();
  try {
    const { id } = await f.service.create(randomUUID(), "FD race");
    await f.service.upload(id, randomUUID(), "init.txt", Buffer.from("init"));
    const base = join(f.root, "work/conversations", id),
      path = join(base, "outputs/file");
    await writeFile(path, "safe");
    const handle = await open(path, "r");
    try {
      await rename(join(base, "outputs"), join(base, "moved"));
      await assert.rejects(assertFileDescriptorPath(handle.fd, path));
    } finally {
      await handle.close();
    }
  } finally {
    await f.service.close();
  }
});

test("an unavailable provider model is refused before input admission or work initialization", async () => {
  const f = await fixture();
  try {
    const { id } = await f.service.create(
      randomUUID(),
      "Unavailable model",
      undefined,
      "chat-latest",
    );
    await assert.rejects(
      f.service.send(id, randomUUID(), "hello"),
      /モデルを選び直してください/,
    );
    assert.equal((await f.service.conversation(id)).status, "idle");
    assert.equal((await f.service.conversation(id)).workspaceCreated, false);
    assert.equal((await f.service.view(id)).transcript.length, 0);
  } finally {
    await f.service.close();
  }
});

test("session deletion denies all reads and admissions, retains disk data, and survives restart without create replay", async () => {
  let f = await fixture([
    call("write", { path: "outputs/keep.txt", content: "retained" }),
    answer("保存しました"),
  ]);
  const creation = randomUUID();
  const { id } = await f.service.create(creation, "削除するセッション");
  const other = await f.service.create(randomUUID(), "残すセッション");
  await f.service.send(id, randomUUID(), "保存して");
  await until(async () => (await f.service.conversation(id)).status === "idle");
  const piId = (await f.service.conversation(id)).piId;
  await f.service.deleteConversation(id);
  await f.service.deleteConversation(id);
  await f.service.close();
  f = await fixture([], { root: f.root });
  try {
    assert.deepEqual(
      (await f.service.list()).map((c) => c.id),
      [other.id],
    );
    for (const request of [
      () => f.service.view(id),
      () => f.service.files(id),
      () => f.service.download(id, "outputs/keep.txt"),
      () => f.service.image(id, 1, 0, 0),
      () => f.service.piConversation(id),
      () => f.service.upload(id, randomUUID(), "file", Buffer.from("x")),
      () => f.service.send(id, randomUUID(), "復活しない"),
      () => f.service.send(id, randomUUID(), "", true),
      () => f.service.selectModel(id, randomUUID()),
      () => f.service.stop(id),
    ])
      await assert.rejects(request(), { statusCode: 404 });
    await assert.rejects(f.service.create(creation, "削除するセッション"), {
      statusCode: 410,
    });
    await assert.rejects(f.service.deleteConversation(randomUUID()), {
      statusCode: 404,
    });
    assert.equal(
      await readFile(
        join(f.root, "work/conversations", id, "outputs/keep.txt"),
        "utf8",
      ),
      "retained",
    );
    const { BACKGROUND_CONTEXT: context } = await import(
      "@earendil-works/chord/context"
    );
    const pi = await f.service.harness.conversation(piId, context);
    assert.ok(pi);
    assert.ok((await pi.entries({}, 40, undefined, context)).items.length);
  } finally {
    await f.service.close();
  }
});

test("session deletion rejects active execution and serializes against input admission", async () => {
  const f = await fixture([call("bash", { command: "sleep 30" })]);
  try {
    const { id } = await f.service.create(randomUUID(), "実行中");
    const other = await f.service.create(randomUUID(), "待機中");
    await f.service.send(id, randomUUID(), "実行");
    await assert.rejects(f.service.deleteConversation(id), { statusCode: 409 });
    await f.service.deleteConversation(other.id);
    assert.equal((await f.service.conversation(id)).status, "running");
    await f.service.stop(id);
    await f.service.deleteConversation(id);
    assert.deepEqual(await f.service.list(), []);

    const next = await f.service.create(randomUUID(), "同時操作");
    const deleted = f.service.deleteConversation(next.id);
    const sent = f.service.send(next.id, randomUUID(), "遅れた入力");
    const results = await Promise.allSettled([deleted, sent]);
    assert.equal(results[0]!.status, "fulfilled");
    assert.equal(results[1]!.status, "rejected");
    await assert.rejects(f.service.conversation(next.id), { statusCode: 404 });
  } finally {
    await f.service.close();
  }
});

test("renaming and bounded search preserve selection; branching is atomic and never replays tools before explicit input", async () => {
  const f = await fixture([
    call("bash", {
      command: "printf once >> effect; printf output > outputs/result.txt",
    }),
    answer("original response needle"),
  ]);
  try {
    const { id } = await f.service.create(randomUUID(), "original");
    const originalText = `original input needle\n${"x".repeat(20000)}`;
    await f.service.send(id, randomUUID(), originalText);
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    const before = await f.service.conversation(id);
    const renamed = await f.service.renameConversation(id, "renamed");
    assert.equal(renamed.title, "renamed");
    assert.equal(renamed.model, before.model);
    assert.equal(renamed.updatedAt, before.updatedAt);
    const entries = (await f.service.view(id)).transcript;
    const input = entries.find((entry) =>
      entry.messages.some((message) => message.role === "user"),
    )!;
    assert.equal(
      input.messages.find((message) => message.role === "user")!.content,
      originalText,
      "Editing must receive the full admitted user text",
    );
    const response = entries.find((entry) =>
      entry.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.includes("original response"),
      ),
    )!;
    const matches = await f.service.search(id, "NEEDLE");
    assert.equal(matches.matches.length, 2);
    assert.match(
      (await f.service.exportConversation(id)).toString(),
      /original input needle/,
    );
    const limit = f.config.limits.fileBytes;
    f.config.limits.fileBytes = 16;
    await assert.rejects(f.service.exportConversation(id), { statusCode: 413 });
    f.config.limits.fileBytes = limit;
    const key = randomUUID();
    const branch = await f.service.branch(id, key, response.id, "fork");
    assert.deepEqual(
      await f.service.branch(id, key, response.id, "fork"),
      branch,
    );
    await assert.rejects(f.service.branch(id, key, response.id, "regenerate"), {
      statusCode: 409,
    });
    assert.equal(
      (await f.service.conversation(branch.id)).workspaceCreated,
      false,
    );
    assert.equal((await f.service.conversation(branch.id)).parentId, id);
    assert.equal((await f.service.conversation(branch.id)).model, before.model);
    assert.equal((await f.service.conversation(branch.id)).requests, 0);
    assert.match(
      JSON.stringify(await f.service.view(branch.id)),
      /original response needle/,
    );
    assert.deepEqual((await f.service.files(branch.id)).files, []);
    assert.equal(
      await readFile(join(f.root, "work/conversations", id, "effect"), "utf8"),
      "once",
    );
    await assert.rejects(f.service.branch(id, randomUUID(), 999999, "fork"), {
      statusCode: 400,
    });
    await assert.rejects(
      f.service.branch(branch.id, randomUUID(), response.id, "edit"),
      { statusCode: 400 },
    );

    const regenerated = await f.service.branch(
      id,
      randomUUID(),
      response.id,
      "regenerate",
    );
    assert.doesNotMatch(
      JSON.stringify(await f.service.view(regenerated.id)),
      /original response needle/,
    );
    assert.match(
      JSON.stringify(await f.service.view(regenerated.id)),
      /original input needle/,
    );
    f.faux.setResponses([answer("new response")]);
    const run = randomUUID();
    await f.service.send(regenerated.id, run, "", false, [], {
      continuing: true,
    });
    await until(
      async () =>
        (await f.service.conversation(regenerated.id)).status === "idle",
    );
    await f.service.send(regenerated.id, run, "", false, [], {
      continuing: true,
    });
    assert.equal((await f.service.conversation(regenerated.id)).requests, 1);
    assert.match(
      JSON.stringify(await f.service.view(regenerated.id)),
      /new response/,
    );
    assert.equal(
      await readFile(join(f.root, "work/conversations", id, "effect"), "utf8"),
      "once",
    );

    const edited = await f.service.branch(id, randomUUID(), input.id, "edit");
    assert.doesNotMatch(
      JSON.stringify(await f.service.view(edited.id)),
      /original input needle/,
    );
    f.faux.setResponses([answer("edited response")]);
    await f.service.send(edited.id, randomUUID(), "edited input", false, [], {
      source: { sessionId: id, entryId: input.id },
    });
    await until(
      async () => (await f.service.conversation(edited.id)).status === "idle",
    );
    assert.match(
      JSON.stringify(await f.service.view(edited.id)),
      /edited input/,
    );
    assert.match(
      JSON.stringify(await f.service.view(id)),
      /original input needle/,
    );
    await f.service.deleteConversation(id);
    await assert.rejects(f.service.search(id, "needle"), { statusCode: 404 });
    await assert.rejects(f.service.renameConversation(id, "restore"), {
      statusCode: 404,
    });
    assert.match(
      JSON.stringify(await f.service.view(branch.id)),
      /original response needle/,
    );
  } finally {
    await f.service.close();
  }
});
