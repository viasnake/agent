import assert from "node:assert/strict";
import test from "node:test";
import { Application } from "../src/application.js";
import { Sandbox } from "../src/sandbox.js";
import {
  fixture,
  gitWorkspace,
  ScriptedRuntime,
  testConfig,
} from "./helpers.js";

test("task model replacement is explicit and does not call a provider", async (t) => {
  let calls = 0;
  const runtime = new ScriptedRuntime(async () => {
    calls++;
    if (calls === 1)
      return JSON.stringify({
        tasks: [
          {
            id: "worker",
            objective: "Inspect the repository",
            role: "worker",
            dependsOn: [],
            write: false,
          },
        ],
      });
    return JSON.stringify({
      outcome: "completed",
      summary: "completed",
      artifacts: [],
      unresolved: [],
    });
  });
  const config = testConfig();
  config.models.worker2 = {
    ...config.models.worker!,
    id: "worker-fixture-2",
  };
  const f = await fixture(runtime, config);
  const workspace = await gitWorkspace(f.root, { "README.md": "baseline\n" });
  t.mock.method(Sandbox.prototype, "probe", async () => ({
    ok: true,
    detail: "fixture",
  }));
  t.mock.method(Sandbox.prototype, "execute", async () => ({
    code: 0,
    stdout: "",
    stderr: "",
    truncated: false,
  }));
  const app = new Application(
    config,
    f.p,
    f.store,
    workspace,
    async () => runtime,
  );
  try {
    await app.initialize();
    app.session.kind = "research";
    await app.submit("Implement a repository change");
    await app.waitForIdle();
    const run = app.currentRun()!;
    assert.equal(run.state, "failed", run.reason);
    assert.ok(run.tasks.length, `calls=${calls}`);
    const attempts = run.tasks[0]!.attempts;
    run.state = "waiting_input";
    run.reason = "fixture waiting state";
    f.store.db
      .prepare("UPDATE runs SET state='waiting_input',payload=? WHERE id=?")
      .run(JSON.stringify(run), run.id);
    const requests = runtime.requests.length;
    const taskId = run.tasks[0]!.id;
    const candidates = app.taskModelCandidates(taskId);
    assert.deepEqual(
      candidates.map((candidate) => candidate.alias),
      ["worker2"],
    );
    const preview = app.previewTaskModelChange(taskId, "worker2");
    assert.equal(runtime.requests.length, requests);
    await app.confirmTaskModelChange(preview);
    const changed = app.currentRun()!;
    assert.equal(changed.state, "waiting_input");
    assert.equal(changed.tasks[0]!.model, "worker2");
    assert.equal(changed.tasks[0]!.attempts, attempts);
    assert.equal(changed.modelChanges?.length, 1);
  } finally {
    await app.close();
    await f.cleanup();
  }
});
