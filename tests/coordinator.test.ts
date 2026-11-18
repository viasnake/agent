import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { CoordinatorDoc } from "../src/coordinator-state.js";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fixture, answer, until } from "./support.js";
import type { AgentService } from "../src/service.js";
import { ConversationsDoc } from "../src/state.js";
import type { JsonObject } from "@earendil-works/pi-durable";
import {
  defineExtension,
  defineTask,
  GenerationTask,
  hook,
  runEndTask,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { fauxProvider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { settingsInput } from "../src/settings.js";

const tool = (name: string, args: JsonObject) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("persistent assistant handles notes without a worker, survives reopen, and cannot fork", async () => {
  const { service, root, runner } = await fixture([answer("承知しました")]);
  const parent = await service.coordinator.ensure();
  assert.deepEqual(await service.coordinator.ensure(), parent);
  let work = 0;
  const original = runner.call.bind(runner);
  runner.call = (...args) => {
    work++;
    return original(...args);
  };
  await service.send(parent.id, randomUUID(), "このメモを読んでください");
  await until(
    async () => (await service.conversation(parent.id)).status === "idle",
  );
  assert.equal(work, 0);
  assert.equal((await service.list()).length, 1);
  assert.match(
    JSON.stringify((await service.view(parent.id)).transcript),
    /承知しました/,
  );
  await assert.rejects(
    service.branch(parent.id, randomUUID(), 1, "fork"),
    /新しい入力/,
  );
  await service.close();
  const reopened = await fixture([], { root });
  try {
    assert.deepEqual(await reopened.service.coordinator.ensure(), parent);
    assert.equal(
      (await reopened.service.coordinator.state()).budgets[0]!.calls,
      1,
    );
  } finally {
    await reopened.service.close();
  }
});

test("parent inspects an incomplete result, requests one correction and records evidence with the current directive", async () => {
  let service: AgentService;
  let parentCalls = 0,
    childCalls = 0;
  const route = async (request: {
    messages: readonly { role: string; content: unknown }[];
  }) => {
    if (
      !JSON.stringify(request.messages).includes("single persistent assistant")
    )
      return fauxAssistantMessage(
        ++childCalls === 1 ? "根拠が不足しています" : "根拠と修正版です",
      );
    parentCalls++;
    if (parentCalls === 1)
      return tool("session_create", {
        title: "調査",
        text: "根拠を調べる",
        criteria: ["根拠を付ける"],
      });
    const child = (await service.list()).find((s) => s.coordinatorId)!;
    if (parentCalls === 3 || parentCalls === 6)
      return tool("session_inspect", { id: child.id });
    if (parentCalls === 4)
      return tool("session_send", {
        id: child.id,
        text: "根拠を補ってください",
        expectedDirectiveVersion: child.directiveVersion!,
        controlEpoch: child.controlEpoch!,
      });
    if (parentCalls === 7) {
      const budget = (await service.coordinator.state()).budgets[0]!;
      return tool("request_update", {
        id: budget.id,
        revision: budget.revision,
        objective: budget.objective,
        criteria: budget.criteria,
        state: "done",
        resultRefs: ["子の修正版と根拠を参照"],
        directives: { [child.id]: child.directiveVersion! },
      });
    }
    return fauxAssistantMessage(
      parentCalls >= 8 ? "修正を確認し、結果を返します" : "作業を待っています",
    );
  };
  ({ service } = await fixture(Array.from({ length: 24 }, () => route)));
  try {
    const parent = await service.coordinator.ensure();
    await service.send(parent.id, randomUUID(), "根拠を調査してください");
    await until(
      async () =>
        parentCalls >= 8 &&
        !service.busy &&
        !(await service.coordinator.state()).events.length,
    );
    const state = await service.coordinator.state();
    assert.equal(state.budgets[0]!.corrections, 1);
    assert.equal(state.budgets[0]!.state, "done");
    assert.equal(childCalls, 2);
    assert.equal(state.budgets[0]!.calls, parentCalls + childCalls);
    assert.equal(state.budgets[0]!.reservedTokens, 0);
    assert.equal(state.budgets[0]!.cost, null);
  } finally {
    await service.close();
  }
});

test("two slots keep the assistant responsive; direct input invalidates stale management and explicit stop persists", async () => {
  let releaseChild!: () => void;
  const childGate = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  let releaseParent!: () => void;
  const parentGate = new Promise<void>((resolve) => {
    releaseParent = resolve;
  });
  let parentRequests = 0,
    childStarted = false,
    holdParent = false;
  const route = async (request: {
    messages: readonly { role: string; content: unknown }[];
  }) => {
    if (
      JSON.stringify(request.messages).includes("single persistent assistant")
    ) {
      parentRequests++;
      if (holdParent) await parentGate;
      return fauxAssistantMessage("短い返答");
    }
    childStarted = true;
    await childGate;
    return fauxAssistantMessage("作業の返答");
  };
  const f = await fixture(Array.from({ length: 30 }, () => route));
  const { service } = f;
  try {
    const parent = await service.coordinator.ensure();
    const child = await service.create(randomUUID(), "直接管理");
    await service.coordinator.bind(child.id, true);
    await service.send(child.id, randomUUID(), "作業を開始");
    await until(
      async () =>
        childStarted && parentRequests > 0 && !service.coordinator.busy,
    );
    assert.equal((await service.conversation(child.id)).status, "running");
    holdParent = true;
    await service.send(parent.id, randomUUID(), "状況を確認したい");
    await until(async () => parentRequests >= 2);
    const old = await service.conversation(child.id);
    await service.send(child.id, randomUUID(), "C案は不要です");
    const updated = await service.conversation(child.id);
    assert.ok(updated.directiveVersion! > old.directiveVersion!);
    const piId = (await service.conversation(parent.id)).piId;
    await assert.rejects(
      service.coordinator.sendChild(
        piId,
        child.id,
        "古いC案の依頼",
        old.directiveVersion!,
        old.controlEpoch!,
      ),
      /更新されています/,
    );
    const unrelated = await service.create(randomUUID(), "独立");
    await assert.rejects(
      service.coordinator.sendChild(piId, unrelated.id, "侵入", 0, 0),
      /管理対象/,
    );
    assert.equal(
      (await service.conversation(unrelated.id)).coordinatorId,
      undefined,
    );
    releaseChild();
    releaseParent();
    await until(
      async () =>
        !service.busy && !(await service.coordinator.state()).events.length,
    );
    await service.stop(child.id);
    const stopped = await service.conversation(child.id);
    assert.equal(stopped.paused, true);
    await service.coordinator.stopAll();
    assert.equal((await service.coordinator.state()).paused, true);
    await service.close();
    const reopened = await fixture([], { root: f.root });
    try {
      assert.equal(
        (await reopened.service.conversation(child.id)).paused,
        true,
      );
      assert.equal((await reopened.service.coordinator.state()).paused, true);
      assert.equal(reopened.service.busy, false);
    } finally {
      await reopened.service.close();
    }
  } finally {
    releaseChild();
    releaseParent();
    await service.close();
  }
});

test("delegation and follow-up generations cannot exceed the originating call allowance", async () => {
  let parents = 0;
  const route = (request: { messages: readonly { content: unknown }[] }) => {
    if (
      JSON.stringify(request.messages).includes("single persistent assistant")
    )
      return ++parents === 1
        ? tool("session_create", {
            title: "予算内の作業",
            text: "確認してください",
            criteria: [],
          })
        : tool("session_inspect", {});
    return tool("read", { path: "outputs/missing.txt" });
  };
  const { service, faux } = await fixture(
    Array.from({ length: 20 }, () => route),
  );
  try {
    const {
      schemaVersion: _,
      hostId: __,
      ...snapshot
    } = service.settings.snapshot();
    await service.saveSettings(
      settingsInput.parse({
        ...snapshot,
        limits: { ...snapshot.limits, modelRequests: 5 },
      }),
    );
    const parent = await service.coordinator.ensure();
    await service.send(parent.id, randomUUID(), "委譲して確認");
    await until(
      async () =>
        !service.busy && !(await service.coordinator.state()).commands.length,
    );
    const budget = (await service.coordinator.state()).budgets[0]!;
    assert.equal(budget.children, 1);
    assert.equal(budget.calls, 5);
    assert.equal(faux.state.callCount, 5);
    assert.equal(budget.reservedTokens, 0);
    assert.equal((await service.list()).length, 2);
  } finally {
    await service.close();
  }
});

test("removing management revokes pending control and retains independent history", async () => {
  const { service } = await fixture([answer("作業結果")]);
  try {
    await service.coordinator.ensure();
    await service.coordinator.stopAll();
    const child = await service.create(randomUUID(), "既存の作業");
    await service.coordinator.bind(child.id, true);
    await service.send(child.id, randomUUID(), "直接依頼");
    await until(async () => !service.busy);
    assert.ok((await service.coordinator.state()).events.length);
    await service.coordinator.bind(child.id, false);
    const independent = await service.conversation(child.id);
    assert.equal(independent.coordinatorId, undefined);
    assert.equal(independent.budgetId, undefined);
    assert.deepEqual((await service.coordinator.state()).events, []);
    assert.match(
      JSON.stringify((await service.view(child.id)).transcript),
      /作業結果/,
    );
    assert.ok(
      (await service.coordinator.state()).budgets.every(
        (b) => !b.sessionIds.includes(child.id),
      ),
    );
  } finally {
    await service.close();
  }
});

test("the response slot remains occupied until usage is committed to its originating request", async () => {
  const { service } = await fixture([answer("回答")]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let accounting = false;
  const account = service.coordinator.account.bind(service.coordinator);
  service.coordinator.account = async (...args) => {
    accounting = true;
    await gate;
    return account(...args);
  };
  try {
    const parent = await service.coordinator.ensure();
    await service.send(parent.id, randomUUID(), "記録の確認");
    await until(async () => accounting);
    assert.equal(service.coordinator.busy, true);
    assert.ok(
      (await service.coordinator.state()).budgets[0]!.reservedTokens > 0,
    );
    await assert.rejects(
      service.send(parent.id, randomUUID(), "割り込まない"),
      /応答が終わって/,
    );
    release();
    await until(async () => !service.busy);
    assert.equal(
      (await service.coordinator.state()).budgets[0]!.reservedTokens,
      0,
    );
  } finally {
    release();
    await service.close();
  }
});

test("knowledge revisions and source deletion remove current and superseded derived text", async () => {
  const { service, root } = await fixture();
  try {
    const parent = await service.coordinator.ensure();
    const source = await service.create(randomUUID(), "議事録");
    const note = await service.coordinator.knowledge.update(
      { title: "決定", body: "旧い派生知識", revision: 0, expired: false },
      [{ sessionId: source.id }],
    );
    await service.coordinator.knowledge.update({
      id: note.id,
      title: "決定",
      body: "新しい派生知識",
      revision: note.revision,
      expired: false,
    });
    await assert.rejects(
      service.coordinator.knowledge.update({
        id: note.id,
        title: "決定",
        body: "古い上書き",
        revision: note.revision,
        expired: false,
      }),
      /更新されています/,
    );
    assert.equal(
      (await service.coordinator.knowledge.list("新しい")).notes.length,
      1,
    );
    await service.deleteConversation(source.id);
    assert.deepEqual((await service.coordinator.knowledge.list()).notes, []);
    await assert.rejects(
      service.coordinator.knowledge.update({
        id: note.id,
        title: "再生",
        body: "失敗すべき",
        revision: 2,
        expired: false,
      }),
      /記憶がありません/,
    );
    assert.equal((await service.conversation(parent.id)).role, "coordinator");
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await service.close();
    const db = await readFile(join(root, "control/conversations-v1.sqlite"));
    assert.equal(db.includes(Buffer.from("旧い派生知識")), false);
    assert.equal(db.includes(Buffer.from("新しい派生知識")), false);
  } finally {
    await service.close();
  }
});

test("handoff preserves the assistant and history, rejects stale input versions, and does not reset the budget", async () => {
  let requests = 0;
  const contexts: string[] = [];
  const { service } = await fixture([
    (request) => {
      contexts.push(JSON.stringify(request.messages));
      requests++;
      return tool("context_handoff", {
        text: "未完了の依頼と最新の条件を引き継ぐ",
        inputVersion: 0,
      });
    },
    (request) => {
      contexts.push(JSON.stringify(request.messages));
      requests++;
      return tool("context_handoff", {
        text: "未完了の依頼と最新の条件を引き継ぐ",
        inputVersion: 1,
      });
    },
    (request) => {
      contexts.push(JSON.stringify(request.messages));
      requests++;
      return fauxAssistantMessage("引き継いで返答");
    },
  ]);
  try {
    const parent = await service.coordinator.ensure();
    const pi = await service.piConversation(parent.id);
    for (let n = 0; n < 1000; n++)
      await pi.submit(
        {
          type: "write",
          entry: {
            kind: "test.past",
            model: [{ role: "user", content: `過去資料 ${n}`, timestamp: 0 }],
          },
        },
        ctx,
      );
    await service.send(parent.id, randomUUID(), "最新の条件を維持");
    await until(async () => !service.coordinator.busy);
    assert.equal(requests, 3);
    assert.match(contexts[0]!, /過去資料 999/);
    assert.match(contexts[0]!, /Context maintenance is due/);
    assert.doesNotMatch(contexts[2]!, /過去資料/);
    assert.match(contexts[2]!, /最新の条件/);
    assert.ok(Buffer.byteLength(contexts[2]!) < 32000);
    assert.equal((await service.coordinator.state()).budgets[0]!.calls, 3);
    assert.equal(
      (await service.coordinator.state()).checkpoint!.inputVersion,
      1,
    );
    const before = await pi.entries({ order: "ascending" }, 1, undefined, ctx);
    assert.equal(before.items[0]!.model![0]!.content, "過去資料 0");
    assert.equal(
      (await service.harness.snapshot(ConversationsDoc, ctx))!.conversations[0]!
        .id,
      parent.id,
    );
  } finally {
    await service.close();
  }
});

test("assistant delegates through Pi, receives one settled result, and child has no management authority", async () => {
  let parentCalls = 0;
  let childCalls = 0;
  const route = (request: {
    messages: readonly { role: string; content: unknown }[];
  }) => {
    const all = JSON.stringify(request.messages);
    if (all.includes("single persistent assistant")) {
      parentCalls++;
      if (parentCalls === 1)
        return fauxAssistantMessage(
          fauxToolCall("session_create", {
            title: "調査",
            text: "資料を調査し根拠を報告",
            criteria: ["根拠を含む"],
          }),
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage("結果を確認しました");
    }
    childCalls++;
    if (childCalls === 1)
      return fauxAssistantMessage(
        fauxToolCall("session_create", {
          title: "不正な孫",
          text: "作成",
          criteria: [],
        }),
        { stopReason: "toolUse" },
      );
    return fauxAssistantMessage("調査結果と根拠");
  };
  const { service } = await fixture(Array.from({ length: 20 }, () => route));
  try {
    const parent = await service.coordinator.ensure();
    await service.send(parent.id, randomUUID(), "調査をお願いします");
    await until(
      async () =>
        parentCalls >= 3 &&
        !service.busy &&
        !(await service.coordinator.state()).events.length,
    );
    const sessions = await service.list();
    assert.equal(sessions.length, 2);
    const child = sessions.find((s) => s.coordinatorId)!;
    assert.equal(child.coordinatorId, parent.id);
    assert.equal(child.parentId, undefined);
    await assert.rejects(
      service.coordinator.createChild(child.piId, "侵入", "invalid", []),
      /管理権限/,
    );
    const state = await service.harness.snapshot(CoordinatorDoc, ctx);
    assert.equal(state!.budgets[0]!.state, "checking");
    assert.equal(state!.budgets[0]!.children, 1);
    assert.ok(state!.budgets[0]!.calls >= 5);
    assert.equal(state!.commands.length, 0);
  } finally {
    await service.close();
  }
});

test("two simultaneous admissions retain distinct model credentials, models and cancellation", async () => {
  const faux = fauxProvider({
    tokensPerSecond: Infinity,
    models: [{ id: "gpt-4.1" }, { id: "gpt-4.1-mini" }],
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let childStarted = false;
  faux.setResponses([
    async () => {
      childStarted = true;
      await gate;
      return fauxAssistantMessage("child");
    },
    fauxAssistantMessage("parent"),
  ]);
  const seen: { key?: string; model: string; signal?: AbortSignal }[] = [];
  const provider = {
    ...faux.provider,
    id: "openai",
    auth: openaiProvider().auth,
    getModels: () =>
      faux.provider.getModels().map((m) => ({ ...m, provider: "openai" })),
    streamSimple: ((model, context, options) => {
      seen.push({
        key: options?.apiKey,
        model: model.id,
        signal: options?.signal,
      });
      return faux.provider.streamSimple(model, context, options);
    }) as typeof faux.provider.streamSimple,
  };
  const { service } = await fixture([], { provider });
  try {
    const {
      schemaVersion: _,
      hostId: __,
      ...snapshot
    } = service.settings.snapshot();
    const first = randomUUID(),
      second = randomUUID();
    await service.saveSettings(
      settingsInput.parse({
        ...snapshot,
        models: [
          {
            id: first,
            provider: "openai",
            model: "gpt-4.1",
            key: "fixture-parent-secret",
          },
          {
            id: second,
            provider: "openai",
            model: "gpt-4.1-mini",
            key: "fixture-child-secret",
          },
        ],
        defaultModel: first,
      }),
    );
    const parent = await service.coordinator.ensure();
    const child = await service.create(
      randomUUID(),
      "independent",
      second,
      "gpt-4.1-mini",
    );
    await service.send(child.id, randomUUID(), "long work");
    await until(async () => childStarted);
    await service.send(parent.id, randomUUID(), "quick response");
    await until(async () => !service.coordinator.busy);
    assert.equal(service.workBusy, true);
    assert.deepEqual(
      seen.map(({ key, model }) => ({ key, model })),
      [
        { key: "fixture-child-secret", model: "gpt-4.1-mini" },
        { key: "fixture-parent-secret", model: "gpt-4.1" },
      ],
    );
    assert.notEqual(seen[0]!.signal, seen[1]!.signal);
    assert.equal(seen[0]!.signal?.aborted, false);
    release();
    await until(async () => !service.workBusy);
  } finally {
    release();
    await service.close();
  }
});

test("result notification waits for afterRun tasks, not only the model answer", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const verify = defineTask<null, { phase: "verify" }, null>({
    name: "test.after-run",
    version: 1,
    initial: () => ({ phase: "verify" }),
    phases: {
      verify: async (_task, runtime, context) => {
        await gate;
        return runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          context,
        );
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      ),
  });
  let parentCalls = 0;
  const route = (request: { messages: readonly { content: unknown }[] }) => {
    if (
      JSON.stringify(request.messages).includes("single persistent assistant")
    ) {
      if (++parentCalls === 1)
        return tool("session_create", {
          title: "検証待ち",
          text: "作業",
          criteria: [],
        });
      return fauxAssistantMessage("parent");
    }
    return fauxAssistantMessage("answer before verification");
  };
  const { service } = await fixture(Array.from({ length: 12 }, () => route));
  service["registry"].install(
    defineExtension({
      name: "test.after-run",
      tasks: [verify],
      hooks: [
        hook(GenerationTask, {
          afterRun: () => ({ tasks: [runEndTask(verify, null)] }),
        }),
      ],
    }),
  );
  try {
    const parent = await service.coordinator.ensure();
    await service.send(parent.id, randomUUID(), "作業を依頼");
    await until(async () => {
      const child = (await service.list()).find((c) => c.coordinatorId);
      return (
        !!child &&
        parentCalls === 2 &&
        !!(await service.harness.snapshot(LiveDoc, child.piId, ctx))?.run
          ?.afterRun
      );
    });
    assert.equal((await service.coordinator.state()).events.length, 0);
    assert.equal(service.workBusy, true);
    release();
    await until(async () => parentCalls === 3 && !service.busy);
  } finally {
    release();
    await service.close();
  }
});
