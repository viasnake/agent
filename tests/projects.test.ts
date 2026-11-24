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
  assert.equal((await f.service.conversation(f.id)).requests, 15);
  assert.equal(
    (await f.service.usageStatistics({ id: f.id }, ctx)).models.reduce(
      (n, m) => n + m.calls,
      0,
    ),
    15,
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
    assert.equal(question.entryId, row!.question!.entryId);
    reopened.faux.setResponses([
      call("project_report", {
        revision: 1,
        stage: "delivered",
        summary: "東京を対象に移行計画をまとめました",
        evidence: "担当の調査と地域の回答を反映",
      }),
      answer("納品しました"),
    ]);
    await service.send(id, randomUUID(), "", false, [], {
      choice: { entryId: question.entryId, option: 0 },
    });
    await until(
      async () => (await service.projects())[0]?.status === "delivered",
    );
    assert.equal((await service.projects())[0]!.members[0]!.status, "reported");
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
