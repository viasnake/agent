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
import { WorkerClient } from "../src/execution/client.js";
import { AgentService } from "../src/service.js";

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
  const f = await fixture(
    [call("mcp_0_0", { name: "Pi" }), answer("挨拶しました")],
    {
      mcp: [
        {
          name: "fixture",
          command: process.execPath,
          args: [resolve(".test-dist/tests/mcp-server.js")],
        },
      ],
    },
  );
  try {
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
    await service.files(id);
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

test("unconfigured model keeps history available and missing production separation has no fallback", async () => {
  const f = await fixture([], { noModel: true });
  try {
    const { id } = await f.service.create(randomUUID(), "モデルなし");
    assert.equal((await f.service.view(id)).modelConfigured, false);
    await assert.rejects(f.service.send(id, randomUUID(), "hello"), /モデル/);
    assert.equal((await f.service.list()).length, 1);
  } finally {
    await f.service.close();
  }
  const runner = new WorkerClient();
  await assert.rejects(runner.ready());
  await runner.close();
  assert.equal(typeof AgentService.open, "function");
});

test("an opened file whose parent moved outside the expected path is refused", async () => {
  const f = await fixture();
  try {
    const { id } = await f.service.create(randomUUID(), "FD race");
    await f.service.files(id);
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
