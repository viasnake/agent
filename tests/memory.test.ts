import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fixture, answer, call, until } from "./support.js";
import { createServer } from "../src/server.js";
import { localDate } from "../src/memory.js";

test("ordinary work exposes autonomous memory policy and lets the agent resolve conflicts, consolidate and forget", async () => {
  const f = await fixture([answer("以前の設定")]);
  try {
    const old = await f.service.create(randomUUID(), "以前の作業");
    const current = await f.service.create(randomUUID(), "今回の作業");
    await f.service.send(old.id, randomUUID(), "このリポジトリは npm を使う");
    await until(
      async () => (await f.service.conversation(old.id)).status === "idle",
    );
    const sourceEntry = (await f.service.view(old.id)).transcript.find(
      (entry) => entry.messages.some((message) => message.role === "user"),
    )!.id;
    const primary = randomUUID(),
      duplicate = randomUUID(),
      obsolete = randomUUID();
    await f.service.memory.save({
      requestId: primary,
      text: "このリポジトリは npm を使う",
      source: { sessionId: old.id, entryId: sourceEntry },
    });
    await f.service.memory.save({
      requestId: duplicate,
      text: "パッケージ管理は npm",
      source: { sessionId: old.id },
    });
    await f.service.memory.save({
      requestId: obsolete,
      text: "移行作業は未着手",
    });
    const update = (revision: number) =>
      fauxAssistantMessage(
        fauxToolCall("memory_update", {
          id: primary,
          revision,
          text: "このリポジトリは pnpm に移行済み。テストには接続確認を含める。",
          merge: [{ id: duplicate, revision: 1 }],
        }),
        { stopReason: "toolUse" },
      );
    f.faux.setResponses([
      async (context) => {
        const system = context.messages.filter(
          (message) => message.role === "system",
        );
        assert.match(JSON.stringify(system), /Do not wait for the user to say/);
        const tools = system
          .flatMap((message) => message.toolsAdded ?? [])
          .map((tool) => tool.name);
        for (const name of [
          "memory_save",
          "memory_update",
          "memory_forget",
          "session_search",
          "session_read",
        ])
          assert.ok(tools.includes(name));
        // A human correction arrives after the model read revision 1.
        await f.service.memory.update(primary, {
          text: "このリポジトリは npm を使う。テストには接続確認を含める。",
          revision: 1,
        });
        return update(1);
      },
      async (context) => {
        assert.match(
          JSON.stringify(
            context.messages.filter((message) => message.role === "toolResult"),
          ),
          /更新されています/,
        );
        const notes = await f.service.memory.list();
        assert.equal(notes.find((note) => note.id === primary)!.revision, 2);
        assert.ok(
          notes.some((note) => note.id === duplicate),
          "A conflicted merge must not delete anything",
        );
        assert.match(JSON.stringify(context.messages[0]), /接続確認/);
        return update(2);
      },
      async () => {
        const notes = await f.service.memory.list();
        assert.ok(!notes.some((note) => note.id === duplicate));
        assert.equal(
          notes.find((note) => note.id === primary)!.source?.sessionId,
          current.id,
        );
        return fauxAssistantMessage(
          fauxToolCall("memory_forget", { id: obsolete, revision: 1 }),
          { stopReason: "toolUse" },
        );
      },
      () =>
        fauxAssistantMessage(
          fauxToolCall("session_read", {
            sessionId: old.id,
            entryId: sourceEntry,
          }),
          { stopReason: "toolUse" },
        ),
      (context) => {
        assert.match(
          JSON.stringify(
            context.messages.filter((message) => message.role === "toolResult"),
          ),
          /このリポジトリは npm を使う/,
        );
        return fauxAssistantMessage(
          fauxToolCall("memory_save", { text: "利用者は短い作業報告を好む" }),
          { stopReason: "toolUse" },
        );
      },
      () => fauxAssistantMessage("作業を続けます"),
    ]);
    await f.service.send(
      current.id,
      randomUUID(),
      "このリポジトリは pnpm に移行済みです。前の作業の続きを進めてください。作業報告はいつも短くしてください。",
    );
    await until(
      async () => (await f.service.conversation(current.id)).status === "idle",
    );
    const notes = await f.service.memory.list();
    assert.equal(notes.length, 2);
    assert.equal(notes.find((note) => note.id === primary)!.revision, 3);
    assert.match(
      notes.find((note) => note.id === primary)!.text,
      /pnpm.*接続確認/,
    );
    assert.ok(
      notes.some(
        (note) =>
          note.text === "利用者は短い作業報告を好む" &&
          note.source?.sessionId === current.id,
      ),
    );
    assert.match(
      JSON.stringify(await f.service.view(current.id)),
      /作業を続けます/,
    );
    assert.equal(
      f.faux.state.callCount,
      7,
      "Memory operations stay within the admitted generation loop",
    );
  } finally {
    await f.service.close();
  }
});

test("consolidation preserves source lineage across reopen and stale forgets cannot delete human edits", async () => {
  let f = await fixture();
  const a = await f.service.create(randomUUID(), "出典 A");
  const b = await f.service.create(randomUUID(), "出典 B");
  const c = await f.service.create(randomUUID(), "統合作業");
  const first = randomUUID(),
    second = randomUUID();
  await f.service.memory.save({
    requestId: first,
    text: "A の記憶",
    source: { sessionId: a.id },
  });
  await f.service.memory.save({
    requestId: second,
    text: "B の記憶",
    source: { sessionId: b.id },
  });
  await f.service.memory.update(
    first,
    { text: "統合した記憶", revision: 1 },
    { source: { sessionId: c.id }, merge: [{ id: second, revision: 1 }] },
  );
  assert.equal((await f.service.memory.list()).length, 1);
  await f.service.memory.update(first, { text: "利用者の修正", revision: 2 });
  await assert.rejects(f.service.memory.forget(first, 2), /更新されています/);
  assert.equal((await f.service.memory.list())[0]!.text, "利用者の修正");
  await f.service.close();
  f = await fixture([], { root: f.root });
  try {
    assert.equal((await f.service.memory.list())[0]!.source?.sessionId, c.id);
    await f.service.deleteConversation(b.id);
    assert.deepEqual(
      await f.service.memory.list(),
      [],
      "Deleting a merged source must hide the consolidated note even when its primary source is still visible",
    );
    await assert.rejects(
      f.service.memory.update(
        first,
        { text: "復活させない", revision: 3 },
        { source: { sessionId: c.id } },
      ),
      /記憶がありません/,
    );
    assert.equal(f.faux.state.callCount, 0);
  } finally {
    await f.service.close();
  }
});

test("notes survive reopen, enter model context without entering history, and respect corrections and deletion", async () => {
  let f = await fixture([answer("最初の会話")]);
  const source = await f.service.create(randomUUID(), "出典");
  const target = await f.service.create(randomUUID(), "続き");
  await f.service.send(
    source.id,
    randomUUID(),
    "このプロジェクトは npm を使います",
  );
  await until(
    async () => (await f.service.conversation(source.id)).status === "idle",
  );
  const entryId = (await f.service.view(source.id)).transcript.find((entry) =>
    entry.messages.some((message) => message.role === "user"),
  )!.id;
  const note = {
    requestId: randomUUID(),
    text: "このプロジェクトは npm を使う",
    source: { sessionId: source.id, entryId },
  };
  await f.service.memory.save(note);
  await f.service.memory.save(note);
  assert.equal((await f.service.memory.list()).length, 1);
  await f.service.memory.update(note.requestId, {
    text: "このプロジェクトは pnpm を使う",
    revision: 1,
  });
  await assert.rejects(
    f.service.memory.update(note.requestId, { text: "古い変更", revision: 1 }),
    /更新されています/,
  );
  await f.service.close();
  f = await fixture(
    [
      (context) => {
        assert.match(
          JSON.stringify(context.messages),
          /このプロジェクトは pnpm を使う/,
        );
        return fauxAssistantMessage("記憶を参照しました");
      },
      (context) => {
        assert.doesNotMatch(
          JSON.stringify(context.messages),
          /このプロジェクトは pnpm を使う/,
        );
        return fauxAssistantMessage("削除後の応答");
      },
    ],
    { root: f.root },
  );
  try {
    assert.equal(f.faux.state.callCount, 0, "Reopen must not start inference");
    assert.equal((await f.service.memory.list())[0]!.revision, 2);
    await f.service.send(target.id, randomUUID(), "続けて");
    await until(
      async () => (await f.service.conversation(target.id)).status === "idle",
    );
    assert.match(
      JSON.stringify(await f.service.view(target.id)),
      /記憶を参照しました/,
    );
    assert.doesNotMatch(
      JSON.stringify(await f.service.view(target.id)),
      /pnpm/,
    );
    await f.service.deleteConversation(source.id);
    assert.deepEqual(await f.service.memory.list(), []);
    await assert.rejects(
      f.service.memory.read({ sessionId: source.id, entryId }),
    );
    await assert.rejects(
      f.service.memory.save({ ...note, requestId: randomUUID() }),
    );
    await f.service.send(target.id, randomUUID(), "もう一度");
    await until(
      async () => (await f.service.conversation(target.id)).status === "idle",
    );
    assert.match(
      JSON.stringify(await f.service.view(target.id)),
      /削除後の応答/,
    );
  } finally {
    await f.service.close();
  }
});

test("memory tools store notes with runtime-owned sources and read other sessions without worker execution", async () => {
  const f = await fixture([
    fauxAssistantMessage(
      [
        { type: "text", text: "x".repeat(13000) },
        fauxToolCall("memory_save", { text: "回答は日本語にする" }),
      ],
      { stopReason: "toolUse" },
    ),
    call("session_search", { query: "覚えて" }),
    (context) => {
      assert.match(JSON.stringify(context.messages), /回答は日本語にする/);
      assert.match(JSON.stringify(context.messages), /sessionId/);
      return fauxAssistantMessage("保存しました");
    },
  ]);
  try {
    const { id } = await f.service.create(randomUUID(), "記憶ツール");
    await f.service.send(id, randomUUID(), "日本語で回答すると覚えてください");
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    const notes = await f.service.memory.list();
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.source?.sessionId, id);
    assert.ok(notes[0]!.source?.entryId);
    const read = await f.service.memory.read(notes[0]!.source!);
    assert.match(JSON.stringify(read), /覚えてください/);
    const requests = f.faux.state.callCount;
    await f.service.memory.search({ query: "日本語" });
    assert.equal(f.faux.state.callCount, requests);
    await f.service.memory.forget(notes[0]!.id, notes[0]!.revision);
    await assert.rejects(
      f.service.memory.save({
        requestId: notes[0]!.id,
        text: notes[0]!.text,
        source: notes[0]!.source,
      }),
      /削除されています/,
    );
    assert.deepEqual(await f.service.memory.list(), []);
  } finally {
    await f.service.close();
  }
});

test("cross-session search paginates, handles short Japanese queries and daily timezone boundaries, and excludes forked ancestors", async () => {
  const stamp = Date.parse("2026-11-08T15:05:00Z");
  const f = await fixture([
    fauxAssistantMessage("認証の設定を確認しました", { timestamp: stamp }),
    answer("分岐後の新規作業"),
  ]);
  try {
    // Empty sessions still consume the bounded per-request scan budget.
    for (let index = 0; index < 5; index++)
      await f.service.create(randomUUID(), `空 ${index}`);
    const { id } = await f.service.create(randomUUID(), "作業");
    await f.service.send(id, randomUUID(), "認証を調べて");
    await until(
      async () => (await f.service.conversation(id)).status === "idle",
    );
    const anchor = (await f.service.view(id)).transcript.find((entry) =>
      entry.messages.some((message) => message.role === "assistant"),
    )!.id;
    const fork = await f.service.branch(id, randomUUID(), anchor, "fork");
    await f.service.send(fork.id, randomUUID(), "新しい作業");
    await until(
      async () => (await f.service.conversation(fork.id)).status === "idle",
    );
    async function collect(input: {
      query?: string;
      date?: string;
      timezone?: string;
    }) {
      const rows: Awaited<
        ReturnType<typeof f.service.memory.search>
      >["matches"] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 30; page++) {
        const result = await f.service.memory.search({ ...input, cursor });
        rows.push(...result.matches);
        if (!result.cursor) return rows;
        cursor = result.cursor;
      }
      throw new Error("Search did not finish");
    }
    const matches = await collect({ query: "認証" });
    assert.equal(matches.length, 2);
    assert.ok(matches.every((match) => match.sessionId === id));
    assert.equal(
      (await collect({ date: "2026-11-09", timezone: "Asia/Tokyo" })).filter(
        (match) => match.entryId === anchor,
      ).length,
      1,
    );
    assert.equal(
      (await collect({ date: "2026-11-09", timezone: "UTC" })).filter(
        (match) => match.entryId === anchor,
      ).length,
      0,
    );
    assert.equal(localDate(stamp, "Asia/Tokyo"), "2026-11-09");
    await assert.rejects(
      f.service.memory.search({ date: "2026-02-30" }),
      /不正/,
    );
    await assert.rejects(
      f.service.memory.search({ date: "2026-11-09", timezone: "not-a-zone" }),
      /不正/,
    );
    const first = await f.service.memory.search({ query: "認証" });
    if (first.cursor)
      await assert.rejects(
        f.service.memory.search({ query: "別の検索", cursor: first.cursor }),
        /検索位置/,
      );
    await f.service.deleteConversation(id);
    assert.deepEqual(await collect({ query: "認証" }), []);
    assert.equal(f.faux.state.callCount, 2);
  } finally {
    await f.service.close();
  }
});

test("memory HTTP endpoints require local sessions and CSRF, enforce bounds, and reject stale writes", async () => {
  const f = await fixture();
  const app = await createServer(f.service);
  const headers: Record<string, string> = {
    host: "127.0.0.1:8080",
    origin: "http://127.0.0.1:8080",
  };
  try {
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/memories", headers }))
        .statusCode,
      401,
    );
    const session = await app.inject({
      method: "GET",
      url: "/api/session",
      headers,
    });
    headers.cookie = session.headers["set-cookie"]!.toString().split(";")[0]!;
    const body = { requestId: randomUUID(), text: "保存する内容" };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/memories",
          headers,
          payload: body,
        })
      ).statusCode,
      403,
    );
    headers["x-csrf-token"] = session.json().csrf;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/memories",
          headers,
          payload: { ...body, text: "x".repeat(1001) },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/memories",
          headers,
          payload: body,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/memories/${body.requestId}`,
          headers,
          payload: { text: "訂正後", revision: 1 },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/memories/${body.requestId}`,
          headers,
          payload: { text: "競合する変更", revision: 1 },
        })
      ).statusCode,
      409,
    );
    const notes = (
      await app.inject({ method: "GET", url: "/api/memories", headers })
    ).json().memories;
    assert.equal(notes[0].text, "訂正後");
    assert.equal(notes[0].requestHash, undefined);
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/memories/${body.requestId}`,
          headers,
          payload: { revision: 1 },
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await app.inject({ method: "GET", url: "/api/memories", headers })
      ).json().memories[0].text,
      "訂正後",
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/api/history?date=2026-02-30",
          headers,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/memories/${body.requestId}`,
          headers,
          payload: { revision: 2 },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/memories/${body.requestId}`,
          headers,
          payload: { revision: 2 },
        })
      ).statusCode,
      200,
      "A lost deletion response can be retried safely",
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/memories",
          headers,
          payload: body,
        })
      ).statusCode,
      410,
    );
    assert.equal(f.faux.state.callCount, 0);
  } finally {
    await app.close();
    await f.service.close();
  }
});
