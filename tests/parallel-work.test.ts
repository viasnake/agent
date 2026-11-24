import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import {
  fauxAssistantMessage,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { fixture, call, answer, until } from "./support.js";
import { WorkDoc, planInput } from "../src/parallel-work.js";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { workFixture } from "./parallel-work-fixture.js";
test("normal Pi request overlaps both producers, checks a frozen patch, repairs one assignment and delivers the same bytes after reopen", async () => {
  const f = await workFixture();
  let release!: () => void;
  const together = new Promise<void>((r) => (release = r));
  const seen = new Set<string>();
  const producer: FauxResponseFactory = async (context) => {
    const { assignment } = JSON.parse(String(context.messages.at(-1)!.content));
    seen.add(assignment.path);
    if (seen.size === 2) release();
    await together;
    return fauxAssistantMessage(
      JSON.stringify({
        content: assignment.path === "README.md" ? "new\n" : "wrong\n",
      }),
    );
  };
  try {
    f.faux.setResponses([
      call("parallel_work", f.plan),
      producer,
      producer,
      answer("See failed check"),
    ]);
    await f.service.send(f.id, randomUUID(), "Make and verify these changes");
    await until(
      async () => (await f.service.conversation(f.id)).status === "idle",
    );
    const first = (await f.view())!;
    assert.equal(first.status, "failed", JSON.stringify(first));
    assert.equal(seen.size, 2);
    assert.equal(first.candidate?.checks.at(-1)?.status, "failed");
    const owner = await f.service.conversation(f.id);
    await assert.rejects(
      f.service.work.download(owner, first.id, first.candidate!.id),
    );
    const refused = first.candidate!.id;
    assert.match(
      (await f.service.work.review(owner, first.id, refused)).patch,
      /\+wrong/,
    );
    await assert.rejects(f.service.exportWorkPatch(f.id, first.id, refused));
    await assert.rejects(
      f.service.controlWork(f.id, first.id, {
        action: "repair",
        revision: first.revision - 1,
        path: "app.txt",
        guidance: "stale",
      }),
    );
    await writeFile(join(f.repo, "README.md"), "uncommitted user text\n");
    f.faux.setResponses([
      call("parallel_work_retry", {
        id: first.id,
        path: "app.txt",
        guidance: "Use new.",
      }),
      answer('{"content":"new\\n"}'),
      answer("Verified"),
    ]);
    await f.service.send(f.id, randomUUID(), "Repair the code file");
    await until(
      async () => (await f.service.conversation(f.id)).status === "idle",
    );
    const second = (await f.view())!;
    assert.equal(second.status, "passed", JSON.stringify(second));
    assert.equal(second.candidate!.checks.at(-1)!.output, "new\n");
    assert.notEqual(second.candidate!.id, first.candidate!.id);
    assert.deepEqual(
      second.assignments.map((a) => a.attempts.length),
      [2, 1],
    );
    assert.equal(second.calls, 3);
    const stats = await f.service.usageStatistics({ id: f.id }, ctx);
    assert.equal(
      stats.models.reduce((sum, row) => sum + row.calls, 0),
      7,
    );

    const bytes = await f.service.work.download(
      owner,
      second.id,
      second.candidate!.id,
    );
    assert.equal(
      await readFile(join(f.repo, "README.md"), "utf8"),
      "uncommitted user text\n",
    );
    assert.deepEqual(
      second.candidates.map((c) => c.status),
      ["failed", "passed"],
    );
    const other = await f.service.create(randomUUID(), "Independent session");
    const accepted = second.candidate!.id;
    await assert.rejects(
      f.service.exportWorkPatch(other.id, second.id, accepted),
    );
    const exported = await f.service.exportWorkPatch(f.id, second.id, accepted);
    assert.equal(
      exported.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const output = join(f.repo, "..", exported.path);
    assert.deepEqual(await readFile(output), bytes);
    f.faux.setResponses([
      call("parallel_work_export", { id: second.id, candidate: accepted }),
      call("bash", {
        command: `git clone -q repo integration && git -C integration switch -qc feature && git -C integration apply --index ../${exported.path} && git -C integration -c user.name=Test -c user.email=test@localhost commit -qm "Use new value"`,
      }),
      answer("Integrated"),
    ]);
    await f.service.send(
      f.id,
      randomUUID(),
      "Apply the passed patch to a feature branch and commit it.",
    );
    await until(
      async () => (await f.service.conversation(f.id)).status === "idle",
    );
    assert.equal(
      execFileSync(
        "git",
        ["-C", join(f.repo, "..", "integration"), "rev-parse", "HEAD^{tree}"],
        { encoding: "utf8" },
      ).trim(),
      second.candidate!.tree,
    );
    assert.deepEqual(
      await f.service.exportWorkPatch(f.id, second.id, accepted),
      exported,
    );
    await writeFile(output, "user-edited export");
    await assert.rejects(f.service.exportWorkPatch(f.id, second.id, accepted));
    assert.equal(await readFile(output, "utf8"), "user-edited export");
    const copy = join(f.root, "apply");
    execFileSync("git", ["clone", "-q", f.repo, copy]);
    execFileSync("git", ["apply", "--index", "-"], { cwd: copy, input: bytes });
    assert.equal(
      execFileSync("git", ["write-tree"], {
        cwd: copy,
        encoding: "utf8",
      }).trim(),
      second.candidate!.tree,
    );
    await f.service.close();
    const reopened = await fixture([], { root: f.root });
    try {
      assert.deepEqual(
        await reopened.service.work.download(
          owner,
          second.id,
          second.candidate!.id,
        ),
        bytes,
      );
      assert.equal(reopened.faux.state.callCount, 0);
    } finally {
      await reopened.service.close();
    }
  } finally {
    release();
    await f.service.close();
  }
});
test("a paused work lets in-flight producers settle, survives restart and checks without replaying either producer", async () => {
  const f = await workFixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const slow: FauxResponseFactory = async () => {
    calls++;
    await gate;
    return fauxAssistantMessage('{"content":"new\\n"}');
  };
  try {
    f.faux.setResponses([
      call("parallel_work", f.plan),
      slow,
      slow,
      answer("Paused"),
    ]);
    await f.service.send(f.id, randomUUID(), "Prepare");
    await until(async () => calls === 2);
    const work = (await f.view())!;
    await f.service.controlWork(f.id, work.id, "pause");
    release();
    await until(async () => (await f.view())?.status === "paused");
    await until(
      async () => (await f.service.conversation(f.id)).status === "idle",
    );
    assert.equal((await f.view())!.candidate, undefined);
    await f.service.close();
    const next = await fixture([], { root: f.root });
    try {
      await next.service.controlWork(f.id, work.id, "resume");
      const result = await next.service.work.wait(
        await next.service.conversation(f.id),
        work.id,
      );
      assert.equal(result.status, "passed");
      assert.equal(next.faux.state.callCount, 0);
    } finally {
      await next.service.close();
    }
  } finally {
    release();
    await f.service.close();
  }
});
test("an abandoned check is marked interrupted on reopen without re-running the test command", async () => {
  const f = await workFixture();
  try {
    const owner = await f.service.conversation(f.id);
    await f.service.harness.commit(async (tx) => {
      (await tx.doc(WorkDoc, owner.piId)).items.push({
        id: randomUUID(),
        plan: f.plan,
        model: "faux-1",
        status: "running",
        detail: "",
        assignments: [
          { attempts: [{ number: 1, state: "ready", content: "new" }] },
          { attempts: [{ number: 1, state: "ready", content: "new" }] },
        ],
        selected: "a".repeat(64),
        candidates: [
          {
            id: "a".repeat(64),
            tree: "1".repeat(40),
            patch: "patch",
            attempts: [1, 1],
            checks: [{ status: "running", output: "" }],
          },
        ],
        calls: 2,
        maxCalls: 8,
        remainingMs: 60000,
        startedAt: Date.now(),
        checkSeconds: 10,
      });
    }, ctx);
    await f.service.close();
    const next = await fixture([], { root: f.root });
    try {
      const w = (await next.service.view(f.id)).work[0]!;
      assert.equal(w.status, "paused");
      assert.equal(w.candidate!.checks[0]!.status, "interrupted");
      assert.equal(next.faux.state.callCount, 0);
    } finally {
      await next.service.close();
    }
  } finally {
    await f.service.close();
  }
});

test("stopping the response leaves work running; cancelling it drains both producers without starting a check", async () => {
  const f = await workFixture();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started = 0;
  const producer: FauxResponseFactory = async () => {
    started++;
    await gate;
    return fauxAssistantMessage('{"content":"ready"}');
  };
  try {
    f.faux.setResponses([call("parallel_work", f.plan), producer, producer]);
    await f.service.send(f.id, randomUUID(), "Start");
    await until(async () => started === 2);
    await f.service.stop(f.id);
    const owner = await f.service.conversation(f.id);
    assert.equal(owner.status, "interrupted");
    const w = (await f.view())!;
    assert.equal(w.status, "running");
    await assert.rejects(f.service.deleteConversation(f.id));
    await f.service.controlWork(f.id, w.id, "cancel");
    release();
    const result = await f.service.work.wait(owner, w.id);
    assert.equal(result.status, "cancelled");
    assert.equal(result.candidate, undefined);
    assert.equal(f.service.busy, false);
    f.faux.setResponses([
      call("parallel_work_status", {}),
      answer("Cancelled"),
    ]);
    await f.service.send(f.id, randomUUID(), "作業の結果は？");
    await until(
      async () => (await f.service.conversation(f.id)).status === "idle",
    );
    const transcript = (await f.service.view(f.id)).transcript;
    const observation = transcript
      .flatMap((entry) => entry.messages)
      .find((m) => m.toolName === "parallel_work_status");
    assert.match(observation!.content, /cancelled/);
    assert.equal(started, 2);
    await assert.rejects(f.service.controlWork(f.id, w.id, "resume"));
  } finally {
    release();
    await f.service.close();
  }
});

test("a failed producer retries independently and charges each dispatch to the current response", async () => {
  const f = await workFixture();
  const producer: FauxResponseFactory = async (context) => {
    const { assignment } = JSON.parse(String(context.messages.at(-1)!.content));
    return fauxAssistantMessage(
      assignment.path === "app.txt" ? "bad JSON" : '{"content":"new\\n"}',
    );
  };
  try {
    f.faux.setResponses([
      call("parallel_work", f.plan),
      producer,
      producer,
      answer("One failed"),
    ]);
    await f.service.send(f.id, randomUUID(), "Start");
    await until(
      async () => (await f.service.conversation(f.id)).status === "idle",
    );
    const w = (await f.view())!;
    assert.deepEqual(
      w.assignments.map((a) => a.attempts[0]!.state),
      ["failed", "ready"],
    );
    assert.equal((await f.service.conversation(f.id)).requests, 4);
    f.faux.setResponses([
      call("parallel_work_retry", { id: w.id }),
      answer('{"content":"new\\n"}'),
      answer("Passed"),
    ]);
    await f.service.send(f.id, randomUUID(), "Retry the failed producer");
    await until(
      async () => (await f.service.conversation(f.id)).status === "idle",
    );
    assert.equal((await f.view())!.status, "passed");
    assert.deepEqual(
      (await f.view())!.assignments.map((a) => a.attempts.length),
      [2, 1],
    );
  } finally {
    await f.service.close();
  }
});

test("three independently owned files share two model slots and read only the selected pinned references", async () => {
  const f = await workFixture();
  const plan = planInput.parse({
    ...f.plan,
    assignments: [
      { ...f.plan.assignments[0], references: ["README.md"] },
      f.plan.assignments[1],
      { path: "tests/value.txt", instruction: "Record the expected value" },
    ],
    check: f.plan.check + " && grep -Fx new tests/value.txt",
  });
  assert.equal(
    planInput.safeParse({
      ...plan,
      assignments: [
        ...plan.assignments,
        { path: "tests", instruction: "overlaps" },
      ],
    }).success,
    false,
  );
  let count = 0,
    active = 0,
    peak = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const inputs = new Map<string, unknown>();
  const draft: FauxResponseFactory = async (context) => {
    const req = JSON.parse(String(context.messages.at(-1)!.content));
    inputs.set(req.assignment.path, req.references);
    count++;
    active++;
    peak = Math.max(active, peak);
    await gate;
    active--;
    return fauxAssistantMessage('```json\n{"content":"new\\n"}\n```');
  };
  try {
    await writeFile(join(f.repo, "README.md"), "local edit");
    f.faux.setResponses([
      call("parallel_work", plan),
      draft,
      draft,
      answer("Paused"),
    ]);
    await f.service.send(f.id, randomUUID(), "Code, docs and tests");
    await until(async () => count === 2);
    const owner = await f.service.conversation(f.id),
      id = (await f.view())!.id;
    await f.service.controlWork(f.id, id, "pause");
    release();
    assert.equal((await f.service.work.wait(owner, id)).status, "paused");
    assert.equal(count, 2);
    await until(
      async () => (await f.service.conversation(f.id)).status === "idle",
    );
    f.faux.setResponses([draft]);
    await f.service.controlWork(f.id, id, "resume");
    const done = await f.service.work.wait(owner, id);
    assert.equal(done.status, "passed", JSON.stringify(done));
    assert.deepEqual(
      done.assignments.map((a) => a.attempts.length),
      [1, 1, 1],
    );
    assert.equal(peak, 2);
    assert.deepEqual(inputs.get("app.txt"), [
      { path: "README.md", content: "old docs\n" },
    ]);
    assert.equal(inputs.get("tests/value.txt"), undefined);
    assert.equal(count, 3);
  } finally {
    release();
    await f.service.close();
  }
});
