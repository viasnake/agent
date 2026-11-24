import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { workFixture } from "./parallel-work-fixture.js";
import { fixture, call, answer, until } from "./support.js";
import type { Member } from "../src/projects.js";

test("the lead delegates competing solutions, specialists investigate and repair against one pinned file and only the selected passing bytes ship", async (t) => {
  const f = await workFixture(true);
  t.after(() => f.service.close());
  let release!: () => void;
  const overlap = new Promise<void>((r) => (release = r)),
    seen = new Set<string>();
  const actual = new Set<string>();
  const worker: FauxResponseFactory = async (context) => {
    const args = JSON.parse(String(context.messages.at(-1)!.content));
    seen.add(args.role);
    if (seen.size === 2) release();
    await overlap;
    const step = (action: Record<string, unknown>) =>
      fauxAssistantMessage(JSON.stringify(action));
    const h = args.history as { action: string; result: string }[];
    const last = h.at(-1);
    if (!last) return step({ action: "list" });
    if (last.action === "list") {
      assert.match(last.result, /app.txt/);
      return step({ action: "read", paths: ["app.txt"] });
    }
    if (last.action === "read") {
      assert.match(last.result, /old/);
      return step({
        action: "check",
        edits: [
          {
            path: "app.txt",
            content: args.role === "A" ? "bad\n" : "new\nB\n",
          },
        ],
      });
    }
    assert.equal(last.action, "check", JSON.stringify(h));
    const checked = JSON.parse(last.result);
    actual.add(String(checked.passed));
    if (!checked.passed)
      return step({
        action: "check",
        edits: [{ path: "app.txt", content: "new\nA\n" }],
      });
    return step({
      action: "report",
      summary: "Independently verified " + args.role,
    });
  };
  const team = {
    revision: 1,
    repository: {
      repo: "repo",
      base: f.plan.base,
      check: "grep -Fx new app.txt",
    },
    assignments: [
      { role: "A", task: "Find and repair the value" },
      { role: "B", task: "Explore and propose an alternative" },
    ],
  };
  const review: FauxResponseFactory = async (context) => {
    const result = context.messages.findLast((m) => m.role === "toolResult")!;
    assert.ok(result.role === "toolResult" && !result.isError);
    const part = result.content[0]!;
    assert.equal(part.type, "text");
    const m = (JSON.parse(part.text) as Member[]).find((x) => x.role === "A")!;
    return fauxAssistantMessage(
      fauxToolCall("project_review", {
        revision: 1,
        member: m.id,
        tree: m.check!.tree,
      }),
      { stopReason: "toolUse" },
    );
  };
  f.faux.setResponses([
    call("project_status", {}),
    call("project_team", team),
    ...Array(9).fill(worker),
    review,
    async (context) => {
      const result = context.messages.findLast((m) => m.role === "toolResult");
      assert.ok(
        result?.role === "toolResult" && result.content[0]?.type === "text",
      );
      const proposal = JSON.parse(result.content[0].text);
      assert.match(proposal.patch, /\+A\n/);
      return fauxAssistantMessage(
        fauxToolCall("project_adopt", {
          revision: 1,
          member: proposal.member,
          tree: proposal.tree,
        }),
        { stopReason: "toolUse" },
      );
    },
    call("project_report", {
      revision: 1,
      stage: "delivered",
      summary: "値を修正しました",
      evidence: "採用した変更が grep -Fx new app.txt に合格",
    }),
    answer('{"verdict":"accept","reason":"記録と一致"}'),
    answer("完了"),
  ]);
  await f.service.send(f.id, randomUUID(), "Find and fix the incorrect value");
  await until(
    async () => (await f.service.conversation(f.id)).status !== "running",
    30000,
  );
  const view = await f.service.view(f.id),
    p = view.project!;
  assert.equal(
    p.status,
    "delivered",
    JSON.stringify(
      view.transcript
        .flatMap((e) => e.messages)
        .map((m) => [m.toolName, m.content.slice(-240)]),
    ),
  );
  const posts = view.timeline!.posts;
  assert.deepEqual(
    posts
      .filter((row) => row.kind === "start")
      .map((p) => p.name)
      .sort(),
    ["A", "B"],
  );
  assert.ok(posts.some((row) => row.kind === "failed" && row.name === "A"));
  assert.equal(posts.filter((row) => row.kind === "passed").length, 2);
  assert.equal(
    posts.find((row) => row.kind === "artifact")?.file,
    p.members.find((m) => m.file)?.file,
  );
  assert.equal(posts.at(-1)?.kind, "delivery");
  assert.deepEqual([...actual].sort(), ["false", "true"]);
  assert.equal(p.members.filter((m) => m.check?.passed).length, 2);
  assert.notEqual(p.members[0]!.check!.tree, p.members[1]!.check!.tree);
  assert.equal(p.members.filter((m) => m.file).length, 1);
  const patch = await readFile(
    join(f.repo, "..", p.members.find((m) => m.file)!.file!),
    "utf8",
  );
  assert.match(patch, /\+A\n/);
  assert.doesNotMatch(patch, /\+B\n/);
  assert.equal((await f.service.conversation(f.id)).requests, 16);
  assert.equal(
    (await f.service.usageStatistics({ id: f.id }, ctx)).models.reduce(
      (n, m) => n + m.calls,
      0,
    ),
    16,
  );
  const old = p.members[0]!;
  f.faux.setResponses([
    answer("指示を受領"),
    call("project_report", {
      revision: 2,
      stage: "delivered",
      summary: "新仕様を確認",
      evidence: "新しい指示の内容を照合",
    }),
    answer('{"verdict":"accept","reason":"記録と一致"}'),
    answer("確認済み"),
  ]);
  await f.service.send(f.id, randomUUID(), "仕様変更です");
  await until(
    async () => (await f.service.conversation(f.id)).status === "idle",
  );
  assert.equal((await f.service.projects())[0]!.revision, 2);
  await assert.rejects(
    f.service.team.adopt(
      await f.service.conversation(f.id),
      { revision: 1, member: old.id, tree: old.check!.tree },
      new AbortController().signal,
    ),
    { statusCode: 409 },
  );
});

test("project decisions resume with existing specialist reports and dashboard state survives reopening", async () => {
  const f = await fixture();
  let service = f.service;
  try {
    const { id } = await service.create(
      randomUUID(),
      "移行",
      undefined,
      undefined,
      true,
    );
    await service.create(randomUUID(), "ordinary");
    f.faux.setResponses([
      call("project_team", {
        revision: 1,
        assignments: [{ role: "調査", task: "現状を要約" }],
      }),
      answer('{"action":"report","summary":"移行に二案あります"}'),
      call("request_user_input", {
        question: "対象の地域を選んでください",
        options: ["東京", "大阪"],
      }),
    ]);
    await service.send(id, randomUUID(), "移行の準備を進めて");
    await until(
      async () => (await service.projects())[0]?.status === "decision",
    );
    const [row] = await service.projects();
    assert.equal((await service.projects()).length, 1);
    assert.equal(row!.members[0]!.status, "reported");
    await service.close();
    const reopened = await fixture([], { root: f.root });
    service = reopened.service;
    const question = (await service.projects())[0]!.question!;
    assert.equal(
      (await service.timeline(id)).posts.at(-1)?.questionId,
      question.entryId,
    );
    assert.equal(question.entryId, row!.question!.entryId);
    reopened.faux.setResponses([
      call("project_report", {
        revision: 1,
        stage: "delivered",
        summary: "東京を対象に移行計画をまとめました",
        evidence: "担当の調査と地域の回答を反映",
      }),
      answer('{"verdict":"accept","reason":"記録と一致"}'),
      answer("納品しました"),
    ]);
    await service.send(id, randomUUID(), "", false, [], {
      choice: { entryId: question.entryId, option: 0 },
    });
    await until(
      async () => (await service.projects())[0]?.status === "delivered",
    );
    assert.equal((await service.projects())[0]!.members[0]!.status, "reported");
    const posts = (await service.timeline(id)).posts;
    assert.ok(
      posts.some(
        (p) =>
          p.kind === "decision" &&
          p.text.includes("東京") &&
          p.questionId === question.entryId,
      ),
    );
    assert.equal(posts.at(-1)?.kind, "delivery");
  } finally {
    await service.close();
  }
});

test("steering a running team dismisses obsolete work and finishes the new directive without a second user action", async (t) => {
  const f = await fixture();
  let release!: () => void,
    started = 0;
  const gate = new Promise<void>((r) => (release = r));
  t.after(async () => {
    release();
    await f.service.close();
  });
  const late: FauxResponseFactory = async () => {
    started++;
    await gate;
    return fauxAssistantMessage('{"action":"report","summary":"obsolete"}');
  };
  f.faux.setResponses([
    call("project_team", {
      revision: 1,
      assignments: [
        { role: "調査", task: "旧仕様を調査" },
        { role: "検証", task: "旧仕様を検証" },
      ],
    }),
    late,
    late,
    answer("受領しました"),
    call("project_report", {
      revision: 2,
      stage: "delivered",
      summary: "新しい指示を反映",
      evidence: "対象を新しい仕様に更新",
    }),
    answer('{"verdict":"accept","reason":"記録と一致"}'),
    answer("更新済み"),
  ]);
  const { id } = await f.service.create(
    randomUUID(),
    "変更依頼",
    undefined,
    undefined,
    true,
  );
  await f.service.send(id, randomUUID(), "旧仕様の作業を開始");
  await until(async () => started === 2);
  await f.service.send(id, randomUUID(), "新仕様に切り替えてください");
  release();
  await until(
    async () => (await f.service.conversation(id)).status !== "running",
  );
  const [row] = await f.service.projects();
  assert.equal(row!.revision, 2);
  assert.equal(row!.status, "delivered", JSON.stringify(row));
  assert.equal(row!.members.length, 0);
  assert.equal(row!.summary, "新しい指示を反映");
  const notes = (await f.service.view(id)).transcript
    .flatMap((e) => e.messages)
    .filter((m) => m.content.startsWith("Agent 自動進行"));
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.visibleInTranscript, false);
});

test("an unsupported release claim returns to the lead and is corrected before delivery", async (t) => {
  const f = await fixture();
  t.after(() => f.service.close());
  const { id } = await f.service.create(
    randomUUID(),
    "release handoff",
    undefined,
    undefined,
    true,
  );
  const report = (summary: string) =>
    call("project_report", {
      revision: 1,
      stage: "delivered",
      summary,
      evidence: "Release notes from the directive.",
    });
  const corrected = "Alpha can ship; Beta is on hold until rollback passes.";
  const accepted: FauxResponseFactory = async (context) => {
    const args = JSON.parse(String(context.messages.at(-1)!.content));
    assert.equal(args.proposal.summary, corrected);
    const [pending] = await f.service.projects();
    assert.equal(pending!.status, "working");
    assert.equal(pending!.assessment!.verdict, "checking");
    return fauxAssistantMessage(
      '{"verdict":"accept","reason":"両方の判定が元の記録と一致"}',
    );
  };
  f.faux.setResponses([
    report("Beta passed tests and both components can ship."),
    answer(
      '{"verdict":"revise","reason":"Beta のテスト合格の記録がなく、ロールバック失敗のため保留です"}',
    ),
    async (context) => {
      const result = context.messages.findLast((m) => m.role === "toolResult");
      assert.ok(
        result?.role === "toolResult" && result.content[0]?.type === "text",
      );
      assert.match(result.content[0].text, /revision_requested/);
      const [row] = await f.service.projects();
      assert.equal(row!.assessment!.verdict, "revise");
      assert.notEqual(row!.status, "delivered");
      return fauxAssistantMessage(
        fauxToolCall("project_report", {
          revision: 1,
          stage: "delivered",
          summary: corrected,
          evidence: "Alpha passed 12 checks; Beta rollback failed.",
        }),
        { stopReason: "toolUse" },
      );
    },
    accepted,
    answer("Done"),
  ]);
  await f.service.send(
    id,
    randomUUID(),
    "Alpha passed 12 checks. Beta rollback failed. Publish a release decision for each component.",
  );
  await until(
    async () => (await f.service.conversation(id)).status !== "running",
  );
  const [p] = await f.service.projects();
  assert.equal(p!.summary, corrected);
  assert.equal(p!.assessment!.verdict, "accept");
  assert.equal(p!.status, "delivered");
});

test("project posts survive paging, retry, steering and reopening; the portfolio excludes archived threads", async () => {
  const f = await fixture();
  let service = f.service;
  const key = randomUUID(),
    directive = "公開前の文案を確認";
  try {
    const { id } = await service.create(
      randomUUID(),
      "案内の準備",
      undefined,
      undefined,
      true,
    );
    const normal = await service.create(randomUUID(), "ordinary");
    f.faux.setResponses([
      call("project_team", {
        revision: 1,
        assignments: [{ role: "編集", task: "案内を作成" }],
      }),
      answer(
        '{"action":"progress","summary":"対象者が二種類いることを確認しました。"}',
      ),
      answer('{"action":"report","summary":"草稿を作成"}'),
      call("request_user_input", {
        question: "誰に公開しますか？",
        options: ["既存", "全員"],
      }),
    ]);
    await service.send(id, key, directive);
    await until(
      async () => (await service.projects())[0]?.status === "decision",
    );
    await service.send(id, key, directive);
    const owner = await service.conversation(id);
    for (let n = 0; n < 52; n++)
      await service.team.progress(owner, {
        revision: 1,
        stage: "working",
        summary: "進捗 " + n,
      });
    const before = (await service.timeline(id)).before!;
    assert.ok(before > 1);
    const first = await service.timeline(id, 2);
    assert.deepEqual(
      first.posts.map((p) => p.text),
      [directive],
    );
    assert.equal((await service.recentProjectPosts()).length, 12);
    await assert.rejects(service.timeline(normal.id), { statusCode: 404 });
    const other = await service.create(
      randomUUID(),
      "別案件",
      undefined,
      undefined,
      true,
    );
    f.faux.setResponses([
      call("request_user_input", {
        question: "対象日は？",
        options: ["今日", "明日"],
      }),
    ]);
    await service.send(other.id, randomUUID(), "対象日を相談");
    await until(
      async () =>
        (await service.timeline(other.id)).posts.at(-1)?.kind === "question",
    );
    assert.ok(
      (await service.recentProjectPosts()).some((p) => p.session === id),
    );
    assert.ok(
      (await service.recentProjectPosts()).some((p) => p.session === other.id),
    );
    f.faux.setResponses([
      call("request_user_input", {
        question: "地域は？",
        options: ["東", "西"],
      }),
    ]);
    await service.send(id, randomUUID(), "別の対象に変更");
    await until(
      async () =>
        (await service.timeline(id)).posts.at(-1)?.text === "地域は？",
    );
    await service.close();
    service = (await fixture([], { root: f.root })).service;
    let page = await service.timeline(id),
      all = page.posts;
    while (page.before) {
      page = await service.timeline(id, page.before);
      all = [...page.posts, ...all];
    }
    assert.deepEqual(
      all.map((p) => p.id),
      all.map((_, i) => i + 1),
    );
    assert.equal(all.filter((p) => p.kind === "directive").length, 2);
    assert.equal(
      all.find((p) => p.actor === "member" && p.kind === "progress")?.text,
      "対象者が二種類いることを確認しました。",
    );
    assert.ok(all.some((p) => p.text === directive && p.revision === 1));
    assert.equal(all.at(-1)?.revision, 2);
    await service.updateConversation(other.id, { archived: true });
    assert.ok(
      (await service.recentProjectPosts()).every((p) => p.session === id),
    );
  } finally {
    await service.close();
  }
});
