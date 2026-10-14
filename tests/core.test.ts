import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { validateConfig } from "../src/config.js";
import { validatePlan, parseResult } from "../src/plan.js";
import { assertDisclosure, selectModel, reserveModel } from "../src/policy.js";
import { safePath, sha256 } from "../src/util.js";
import { Store } from "../src/storage.js";
import {
  ScriptedRuntime,
  fixture,
  completed,
  call,
  testConfig,
} from "./helpers.js";

const planTask = (id: string, dependsOn: string[] = [], write = false) => ({
  id,
  dependsOn,
  write,
  role: "worker",
  objective: "test",
});
test("DAG validation rejects duplicate IDs, cycles, missing dependencies and simultaneous writers", () => {
  for (const tasks of [
    [planTask("a"), planTask("a")],
    [planTask("a", ["b"]), planTask("b", ["a"])],
    [planTask("a", ["missing"])],
    [planTask("a", [], true), planTask("b", [], true)],
  ])
    assert.throws(() => validatePlan({ tasks }, 8));
  assert.equal(
    validatePlan(
      { tasks: [planTask("a", [], true), planTask("b", ["a"], true)] },
      8,
    ).length,
    2,
  );
  assert.throws(() =>
    validatePlan(
      { tasks: [{ ...planTask("review", [], true), role: "reviewer" }] },
      8,
    ),
  );
  assert.throws(() =>
    validatePlan({ tasks: [planTask("a")], permissions: "all" }, 8),
  );
});
test("model reports must be complete JSON with no unresolved success", () => {
  assert.equal(parseResult(completed()).outcome, "completed");
  assert.throws(() => parseResult("Everything is complete"));
  assert.throws(() => parseResult('{"outcome":"completed"}'));
  assert.throws(() =>
    parseResult(
      JSON.stringify({
        outcome: "completed",
        summary: "done",
        artifacts: [],
        unresolved: ["missing tests"],
      }),
    ),
  );
});
test("configuration rejects unknown fields, remote local endpoints and beta privacy escalation", () => {
  const config = testConfig();
  assert.doesNotThrow(() => validateConfig(config));
  assert.throws(() => validateConfig({ ...config, secret: "not-a-setting" }));
  assert.throws(() =>
    validateConfig({
      ...config,
      connections: {
        ...config.connections,
        local: {
          ...config.connections.local,
          endpoint: "http://example.com/v1",
        },
      },
    }),
  );
  assert.throws(() =>
    validateConfig({
      ...config,
      connections: {
        beta: {
          type: "sarashina",
          account: "test",
          billing: "beta",
          allowedData: ["private"],
        },
      },
    }),
  );
  assert.throws(() =>
    validateConfig({
      ...config,
      models: { worker: { ...config.models.worker, connection: "missing" } },
    }),
  );
});
test("local-only and restricted data refuse every external target, including summaries", () => {
  assert.throws(() =>
    assertDisclosure(
      { localOnly: true, dataClass: "public" },
      { local: false, allowedData: ["public"] },
      "classifier",
    ),
  );
  assert.throws(() =>
    assertDisclosure(
      { localOnly: false, dataClass: "restricted" },
      { local: false, allowedData: ["restricted"] },
      "MCP",
    ),
  );
  assert.throws(() =>
    assertDisclosure(
      { localOnly: false, dataClass: "private" },
      { local: false, allowedData: ["public"] },
      "beta",
    ),
  );
  assert.doesNotThrow(() =>
    assertDisclosure(
      { localOnly: true, dataClass: "restricted" },
      { local: true, allowedData: ["restricted"] },
      "local",
    ),
  );
});
test("successful writing requires a real nonempty artifact and records usage", async () => {
  const runtime = new ScriptedRuntime(async (request) => {
    await call(request, "write_file", {
      path: "answer.md",
      content: "# 結果\n保存した文章です。",
      expectedSha256: null,
    });
    return completed(["answer.md"]);
  });
  const f = await fixture(runtime);
  try {
    const run = await f.harness.create({
        kind: "writing",
        objective: "日本語の文章を作成",
      }),
      result = await f.harness.execute(run.id);
    assert.equal(result.state, "succeeded");
    assert.equal(f.store.usage(run.id).requests, 1);
    const artifact = f.store
      .artifacts(run.id)
      .find((a) => a.kind === "document")!;
    assert.match((await f.store.content(artifact)).toString(), /保存した文章/);
    const file = join(f.store.runDir(run.id), "artifacts", artifact.sha256);
    await writeFile(file, "tampered");
    await assert.rejects(() => f.store.content(artifact), /hash mismatch/);
  } finally {
    await f.cleanup();
  }
});
test("artifacts retain save order and deduplicate inherited sources", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const parent = await f.harness.create({
      kind: "research",
      objective: "source",
    });
    const owner = f.store.claim(parent.id);
    const source = await f.store.artifact(
      owner,
      "source",
      "source",
      "evidence",
    );
    f.store.release(owner);
    const created = await f.harness.create({
      kind: "writing",
      objective: "outputs",
    });
    const run = f.store.claim(created.id);
    f.store.inheritSources(parent.id, run.id);
    const outputs = [];
    for (const id of ["c", "b", "a"]) {
      const artifact = await f.store.artifact(run, id, "report", id);
      const renamed = { ...artifact, id };
      f.store.db
        .prepare("UPDATE artifacts SET id=?,payload=? WHERE id=?")
        .run(id, JSON.stringify(renamed), artifact.id);
      outputs.push(renamed);
    }
    f.store.db
      .prepare("INSERT INTO source_links VALUES (?,?)")
      .run(run.id, "b");
    f.store.release(run);
    const reopened = new Store(f.p);
    try {
      assert.deepEqual(reopened.artifacts(run.id), [source, ...outputs]);
      assert.equal(reopened.artifacts(run.id).at(-1)?.id, "a");
      assert.deepEqual(reopened.artifacts(parent.id), [source]);
    } finally {
      reopened.close();
    }
  } finally {
    await f.cleanup();
  }
});
test("an invented artifact never produces a successful run", async () => {
  const f = await fixture(
    new ScriptedRuntime(async () => completed(["nonexistent.md"])),
  );
  try {
    const run = await f.harness.create({ kind: "writing", objective: "write" });
    assert.equal((await f.harness.execute(run.id)).state, "failed");
  } finally {
    await f.cleanup();
  }
});
test("separate reviewer sees evidence but has no file writer tool", async () => {
  const runtime = new ScriptedRuntime(async (request) => {
    if (request.role === "worker") {
      await call(request, "write_file", {
        path: "answer.md",
        content: "review me",
        expectedSha256: null,
      });
      return completed(["answer.md"]);
    }
    assert.equal(request.role, "reviewer");
    assert.equal(
      request.tools.some((t) => t.name === "write_file"),
      false,
    );
    assert.match(request.objective, /answer.md/);
    assert.match(
      await call(request, "read_file", {
        path: "answer.md",
        startLine: 1,
        lines: 10,
      }),
      /review me/,
    );
    return completed();
  });
  const f = await fixture(runtime);
  try {
    const run = await f.harness.create({
      kind: "writing",
      objective: "write",
      mode: "reviewed",
    });
    assert.equal((await f.harness.execute(run.id)).state, "succeeded");
    assert.deepEqual(
      runtime.requests.map((r) => r.model),
      ["worker", "reviewer"],
    );
  } finally {
    await f.cleanup();
  }
});
test("no eligible model waits without emitting any model request", async () => {
  const config = testConfig();
  config.connections.local!.enabled = false;
  const runtime = new ScriptedRuntime(async () => completed()),
    f = await fixture(runtime, config);
  try {
    const run = await f.harness.create({ kind: "writing", objective: "write" });
    assert.equal((await f.harness.execute(run.id)).state, "waiting_input");
    assert.equal(runtime.requests.length, 0);
  } finally {
    await f.cleanup();
  }
});
test("explicit model selection cannot override privacy or independent review", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const run = await f.harness.create({ kind: "writing", objective: "write" });
    assert.equal(selectModel(f.config, run, "worker", true), "worker");
    assert.throws(() => selectModel(f.config, run, "reviewer", true, "worker"));
    assert.throws(() =>
      selectModel(f.config, run, "worker", true, "worker", "worker"),
    );
  } finally {
    await f.cleanup();
  }
});
test("active leases and generations reject duplicate owners and late responses", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const initial = await f.harness.create({
        kind: "writing",
        objective: "write",
      }),
      owned = f.store.claim(initial.id),
      other = new Store(f.p);
    try {
      assert.throws(() => other.claim(initial.id), /live lease/);
      f.store.release(owned);
      const newer = other.claim(initial.id);
      assert.throws(() => f.store.save(owned), /owned by another/);
      other.release(newer);
    } finally {
      other.close();
    }
  } finally {
    await f.cleanup();
  }
});
test("crash recovery holds reservations and blocks on dispatched operations", async () => {
  const runtime = new ScriptedRuntime(async () => completed()),
    f = await fixture(runtime);
  try {
    const run = await f.harness.create({ kind: "writing", objective: "write" }),
      owned = f.store.claim(run.id);
    const operation = f.store.prepare(owned, "work", "shell", {
      command: "do something",
    });
    f.store.operation(owned, operation, "dispatched");
    f.store.reserve(owned, "test-api", "model", 0.2, 1, 10, 10);
    f.store.release(owned);
    const resumed = await f.harness.execute(run.id);
    assert.equal(resumed.state, "waiting_approval");
    assert.equal(runtime.requests.length, 0);
    assert.equal(f.store.operations(run.id)[0]!.status, "unknown");
    assert.equal(f.store.usage(run.id).heldUsd, 0.2);
  } finally {
    await f.cleanup();
  }
});
test("budget reservations are atomic across database handles and unknown cost is retained", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const run = await f.harness.create({ kind: "writing", objective: "write" }),
      owned = f.store.claim(run.id),
      other = new Store(f.p);
    try {
      const first = f.store.reserve(owned, "a", "m", 0.6, 1, 20, 10);
      assert.throws(
        () => other.reserve(owned, "a", "m", 0.6, 1, 20, 10),
        /budget/,
      );
      f.store.settle(owned, first, {
        input: null,
        output: null,
        costUsd: null,
      });
      assert.equal(f.store.usage(run.id).heldUsd, 0.6);
      assert.throws(() => other.reserve(owned, "a", "m", 0.6, 1, 20, 10));
    } finally {
      f.store.release(owned);
      other.close();
    }
  } finally {
    await f.cleanup();
  }
});
test("rate limits and cooldowns span runs on the same connection", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const a = await f.harness.create({ kind: "writing", objective: "a" }),
      b = await f.harness.create({ kind: "writing", objective: "b" }),
      one = f.store.claim(a.id),
      two = f.store.claim(b.id);
    f.store.reserve(one, "same", "m", 0, 0, 10, 1);
    assert.throws(
      () => f.store.reserve(two, "same", "m", 0, 0, 10, 1),
      /per-minute/,
    );
    f.store.cooldown("other", Date.now() + 60000);
    assert.throws(
      () => f.store.reserve(two, "other", "m", 0, 0, 10, 10),
      /cooling down/,
    );
    f.store.release(one);
    f.store.release(two);
  } finally {
    await f.cleanup();
  }
});
test("cancel before dispatch makes no new operations or requests", async () => {
  const runtime = new ScriptedRuntime(async () => completed()),
    f = await fixture(runtime);
  try {
    const run = await f.harness.create({ kind: "writing", objective: "write" });
    f.store.cancel(run.id);
    assert.equal((await f.harness.execute(run.id)).state, "cancelled");
    assert.equal(runtime.requests.length, 0);
    assert.equal(f.store.operations(run.id).length, 0);
  } finally {
    await f.cleanup();
  }
});
test("cancellation propagates during active runtime work", async () => {
  const runtime = new ScriptedRuntime(async (request) => {
      await new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      request.signal.throwIfAborted();
      return completed();
    }),
    f = await fixture(runtime);
  try {
    const run = await f.harness.create({ kind: "writing", objective: "write" }),
      controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    assert.equal(
      (await f.harness.execute(run.id, controller.signal)).state,
      "cancelled",
    );
    clearTimeout(timer);
  } finally {
    await f.cleanup();
  }
});
test("symlink and traversal paths cannot read outside a copy", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const root = join(f.root, "copy");
    await mkdir(root);
    await symlink("/etc", join(root, "escape"));
    await assert.rejects(() => safePath(root, "escape/passwd"));
    await assert.rejects(() => safePath(root, "../secret", true));
    await assert.rejects(() => safePath(root, ".git/config", true));
    await assert.rejects(() => safePath(root, "/etc/passwd"));
  } finally {
    await f.cleanup();
  }
});
test("writing tools enforce hashes and exact unique edits", async () => {
  const runtime = new ScriptedRuntime(async (request) => {
    await call(request, "write_file", {
      path: "answer.md",
      content: "hello hello",
      expectedSha256: null,
    });
    await assert.rejects(
      () =>
        call(request, "write_file", {
          path: "answer.md",
          content: "overwrite",
          expectedSha256: null,
        }),
      /does not match/,
    );
    await assert.rejects(
      () =>
        call(request, "edit_file", {
          path: "answer.md",
          oldText: "hello",
          newText: "bye",
        }),
      /exactly once/,
    );
    await call(request, "write_file", {
      path: "answer.md",
      content: "preserved",
      expectedSha256: sha256("hello hello"),
    });
    return completed(["answer.md"]);
  });
  const f = await fixture(runtime);
  try {
    const run = await f.harness.create({
      kind: "writing",
      objective: "write",
      mustKeep: ["preserved"],
    });
    assert.equal((await f.harness.execute(run.id)).state, "succeeded");
  } finally {
    await f.cleanup();
  }
});
test("source citations must refer to a real preserved source and valid lines", async () => {
  const runtime = new ScriptedRuntime(async (request) => {
    const input = JSON.parse(request.objective) as { evidence: string },
      evidence = JSON.parse(input.evidence) as {
        sources: Array<{ id: string }>;
      };
    await call(request, "write_file", {
      path: "research.md",
      content: `事実です。[source:${evidence.sources[0]!.id}:L1-L2]`,
      expectedSha256: null,
    });
    return completed(["research.md"]);
  });
  const f = await fixture(runtime);
  try {
    const file = join(f.root, "source.md");
    await writeFile(file, "fact one\nfact two");
    const run = await f.harness.create({
      kind: "research",
      objective: "research",
      inputs: [file],
    });
    assert.equal((await f.harness.execute(run.id)).state, "succeeded");
  } finally {
    await f.cleanup();
  }
});
test("input limits fail before dispatch and changed policy cannot resume", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const run = await f.harness.create({ kind: "writing", objective: "write" }),
      owned = f.store.claim(run.id);
    assert.throws(
      () => reserveModel(f.config, f.store, owned, "worker", 9_000_000),
      /Input exceeds/,
    );
    f.store.release(owned);
    f.config.limits.maxRequests++;
    await assert.rejects(
      () => f.harness.execute(run.id),
      /Configuration changed/,
    );
  } finally {
    await f.cleanup();
  }
});
test("completed result text alone is not an output artifact", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const run = await f.harness.create({ kind: "writing", objective: "write" });
    assert.equal((await f.harness.execute(run.id)).state, "failed");
  } finally {
    await f.cleanup();
  }
});

test("deletion excludes apply leases and holds its own lease until files are removed", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const created = await f.harness.create({
      kind: "writing",
      objective: "test retention",
    });
    const run = f.store.claim(created.id);
    f.store.transition(run, "succeeded");
    await assert.rejects(
      () => f.store.remove(run.id),
      /active operation lease/,
    );
    f.store.release(run);
    const removal = f.store.remove(run.id);
    assert.throws(() => f.store.claim(run.id, true), /live lease/);
    await removal;
    assert.throws(() => f.store.get(run.id), /Unknown run/);
  } finally {
    await f.cleanup();
  }
});
test("account quotas cannot be bypassed with connection aliases", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const created = await f.harness.create({
        kind: "writing",
        objective: "quota aliases",
      }),
      run = f.store.claim(created.id);
    f.store.reserve(run, "alias-a", "one", 0, 0, 10, 1, "provider:account");
    assert.throws(
      () =>
        f.store.reserve(run, "alias-b", "two", 0, 0, 10, 1, "provider:account"),
      /per-minute/,
    );
    f.store.release(run);
  } finally {
    await f.cleanup();
  }
});

test("a crash during input preparation never executes a partial snapshot", async () => {
  const runtime = new ScriptedRuntime(async () => completed()),
    f = await fixture(runtime);
  try {
    const created = await f.harness.create({
      kind: "writing",
      objective: "snapshot recovery",
    });
    const run = f.store.claim(created.id);
    run.prepared = false;
    f.store.save(run);
    f.store.release(run);
    const result = await f.harness.execute(run.id);
    assert.equal(result.state, "failed");
    assert.match(result.reason!, /PREPARATION_INCOMPLETE/);
    assert.equal(runtime.requests.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("runtime cleanup failure prevents success and still releases the lease", async () => {
  const runtime = new ScriptedRuntime(async (request) => {
    await call(request, "write_file", {
      path: "result.md",
      content: "A complete document",
      expectedSha256: null,
    });
    return completed(["result.md"]);
  });
  runtime.close = async () => {
    throw new Error("fixture cleanup failure");
  };
  const f = await fixture(runtime);
  try {
    const run = await f.harness.create({
      kind: "writing",
      objective: "Write a document",
    });
    const result = await f.harness.execute(run.id);
    assert.equal(result.tasks[0]?.state, "succeeded");
    assert.equal(result.state, "failed");
    assert.match(result.reason!, /cleanup failure/);
    // Removal takes its own lease; a leaked heartbeat would reject it as RUN_BUSY.
    await f.store.remove(run.id);
    assert.throws(() => f.store.get(run.id), /Unknown run/);
  } finally {
    await f.cleanup();
  }
});

test("cancellation during resource cleanup cannot publish success", async () => {
  const controller = new AbortController();
  const runtime = new ScriptedRuntime(async (request) => {
    await call(request, "write_file", {
      path: "result.md",
      content: "A complete document",
      expectedSha256: null,
    });
    return completed(["result.md"]);
  });
  runtime.close = async () => {
    controller.abort();
  };
  const f = await fixture(runtime);
  try {
    const run = await f.harness.create({
      kind: "writing",
      objective: "Write a document",
    });
    const result = await f.harness.execute(run.id, controller.signal);
    assert.equal(result.tasks[0]?.state, "succeeded");
    assert.equal(result.state, "cancelled");
    await f.store.remove(run.id);
  } finally {
    await f.cleanup();
  }
});
