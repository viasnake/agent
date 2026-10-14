import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile, readFile, lstat, symlink, chmod } from "node:fs/promises";
import {
  fixture,
  ScriptedRuntime,
  completed,
  gitWorkspace,
  call,
  testConfig,
} from "./helpers.js";
import {
  applyFiles,
  inventory,
  readSnapshot,
  verifyOriginal,
  workspaceDiff,
} from "../src/workspace.js";
import { Sandbox } from "../src/sandbox.js";
import { TaskTools } from "../src/tools.js";

test("snapshot keeps dirty tracked files and selected untracked files without touching the source", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const origin = await gitWorkspace(f.root, {
      "app.txt": "baseline",
      ".env": "SECRET=do-not-copy",
    });
    await writeFile(join(origin, "app.txt"), "dirty user work");
    await writeFile(join(origin, "extra.txt"), "untracked");
    const run = await f.harness.create({
        kind: "coding",
        objective: "change",
        workspace: origin,
        includeUntracked: true,
      }),
      directory = f.store.runDir(run.id),
      snapshot = await readSnapshot(directory);
    assert.equal(
      await readFile(join(directory, "work", "app.txt"), "utf8"),
      "dirty user work",
    );
    assert.ok(snapshot.files["extra.txt"]);
    assert.equal(snapshot.files[".env"], undefined);
    assert.equal(
      await readFile(join(origin, "app.txt"), "utf8"),
      "dirty user work",
    );
    await verifyOriginal(snapshot);
  } finally {
    await f.cleanup();
  }
});
test("explicit apply checks source changes and refuses new untracked collisions", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const origin = await gitWorkspace(f.root, { "app.txt": "baseline" }),
      run = await f.harness.create({
        kind: "coding",
        objective: "change",
        workspace: origin,
      }),
      directory = f.store.runDir(run.id),
      work = join(directory, "work");
    await writeFile(join(work, "app.txt"), "agent change");
    const approved = await inventory(work, f.config.limits.maxWorkspaceBytes);
    await writeFile(join(origin, "app.txt"), "new user work");
    await assert.rejects(
      () => applyFiles(directory, approved, f.config),
      /Source workspace changed/,
    );
    assert.equal(
      await readFile(join(origin, "app.txt"), "utf8"),
      "new user work",
    );
    await writeFile(join(origin, "app.txt"), "baseline");
    await writeFile(join(work, "new.txt"), "new agent file");
    await writeFile(join(origin, "new.txt"), "untracked user file");
    const withNew = await inventory(work, f.config.limits.maxWorkspaceBytes);
    await assert.rejects(
      () => applyFiles(directory, withNew, f.config),
      /untracked file/,
    );
    assert.equal(await readFile(join(origin, "app.txt"), "utf8"), "baseline");
  } finally {
    await f.cleanup();
  }
});
test("apply preserves executable modes and refuses tampering after validation", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const origin = await gitWorkspace(f.root, { "app.txt": "baseline" }),
      run = await f.harness.create({
        kind: "coding",
        objective: "change",
        workspace: origin,
      }),
      directory = f.store.runDir(run.id),
      work = join(directory, "work");
    await writeFile(join(work, "app.txt"), "updated");
    await chmod(join(work, "app.txt"), 0o755);
    const approved = await inventory(work, f.config.limits.maxWorkspaceBytes);
    const delta = await workspaceDiff(
      directory,
      f.config.limits.maxWorkspaceBytes,
    );
    assert.match(delta.patch, /-baseline/);
    assert.match(delta.patch, /\+updated/);
    await writeFile(join(work, "app.txt"), "changed after validation");
    await assert.rejects(
      () => applyFiles(directory, approved, f.config),
      /changed after validation/,
    );
    await writeFile(join(work, "app.txt"), "updated");
    await applyFiles(directory, approved, f.config);
    assert.equal(await readFile(join(origin, "app.txt"), "utf8"), "updated");
    assert.equal(
      (await lstat(join(origin, "app.txt"))).mode & 0o777,
      approved["app.txt"]!.mode,
    );
  } finally {
    await f.cleanup();
  }
});
test("assisted workflow validates a lead plan and integrates sequential workers before review", async () => {
  const runtime = new ScriptedRuntime(async (request) => {
    if (request.role === "lead")
      return JSON.stringify({
        tasks: [
          {
            id: "draft",
            role: "worker",
            objective: "draft",
            dependsOn: [],
            write: true,
            model: "worker",
          },
          {
            id: "refine",
            role: "worker",
            objective: "refine",
            dependsOn: ["draft"],
            write: true,
            model: "worker",
          },
          {
            id: "review",
            role: "reviewer",
            objective: "review",
            dependsOn: ["refine"],
            write: false,
            model: "reviewer",
          },
        ],
      });
    const task = JSON.parse(request.objective) as { taskObjective: string };
    if (task.taskObjective === "draft") {
      await call(request, "write_file", {
        path: "answer.md",
        content: "Draft",
        expectedSha256: null,
      });
      return completed(["answer.md"]);
    }
    if (task.taskObjective === "refine") {
      await call(request, "edit_file", {
        path: "answer.md",
        oldText: "Draft",
        newText: "Finished document",
      });
      return completed(["answer.md"]);
    }
    assert.match(
      await call(request, "read_file", {
        path: "answer.md",
        startLine: 1,
        lines: 10,
      }),
      /Finished document/,
    );
    return completed();
  });
  const f = await fixture(runtime);
  try {
    const run = await f.harness.create({
      kind: "writing",
      mode: "assisted",
      objective: "compose",
    });
    const result = await f.harness.execute(run.id);
    assert.equal(result.state, "succeeded", result.reason);
    assert.equal(result.tasks.length, 3);
    assert.deepEqual(
      runtime.requests.map((r) => r.role),
      ["lead", "worker", "worker", "reviewer"],
    );
  } finally {
    await f.cleanup();
  }
});
test("independent review failure triggers a bounded repair and re-review", async () => {
  let drafts = 0,
    reviews = 0;
  const runtime = new ScriptedRuntime(async (request) => {
    if (request.role === "worker") {
      if (drafts++ === 0)
        await call(request, "write_file", {
          path: "answer.md",
          content: "wrong",
          expectedSha256: null,
        });
      else
        await call(request, "edit_file", {
          path: "answer.md",
          oldText: "wrong",
          newText: "correct",
        });
      return completed(["answer.md"]);
    }
    if (reviews++ === 0)
      return JSON.stringify({
        outcome: "failed",
        summary: "Replace wrong with correct",
        artifacts: [],
        unresolved: ["incorrect fact"],
      });
    assert.match(
      await call(request, "read_file", {
        path: "answer.md",
        startLine: 1,
        lines: 5,
      }),
      /correct/,
    );
    return completed();
  });
  const f = await fixture(runtime);
  try {
    const run = await f.harness.create({
      kind: "writing",
      mode: "reviewed",
      objective: "write",
    });
    const result = await f.harness.execute(run.id);
    assert.equal(result.state, "succeeded", result.reason);
    assert.equal(result.repairAttempts, 1);
    assert.equal(reviews, 2);
  } finally {
    await f.cleanup();
  }
});
test("real Linux sandbox hides host secrets and blocks network and reviewer writes", async (t) => {
  const config = testConfig();
  config.execution.backend = "bubblewrap";
  const f = await fixture(new ScriptedRuntime(async () => completed()), config);
  try {
    const run = await f.harness.create({
        kind: "writing",
        objective: "sandbox probe",
      }),
      work = join(f.store.runDir(run.id), "work"),
      sandbox = new Sandbox(config.execution),
      probe = await sandbox.probe(work);
    if (!probe.ok) {
      if (process.env.AGENT_REQUIRE_SANDBOX === "1") assert.fail(probe.detail);
      t.skip(probe.detail);
      return;
    }
    const result = await sandbox.execute(
      work,
      'test ! -e /home/vagrant/.codex && test ! -e /etc/shadow && test ! -e /var/run/docker.sock && test -z "$AGENT_TEST_SECRET" && printf isolated > result.txt',
      new AbortController().signal,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(join(work, "result.txt"), "utf8"), "isolated");
    assert.notEqual(
      (
        await sandbox.execute(
          work,
          "printf changed > result.txt",
          new AbortController().signal,
          true,
        )
      ).code,
      0,
    );
    const network = await sandbox.execute(
      work,
      "python3 -c 'import socket; s=socket.socket(); s.settimeout(1); s.connect((\"1.1.1.1\",443))'",
      new AbortController().signal,
    );
    assert.notEqual(network.code, 0);
    await symlink("/etc/passwd", join(work, "escape"));
    const owned = f.store.claim(run.id),
      task = {
        id: "read",
        role: "reviewer" as const,
        objective: "read",
        dependsOn: [],
        write: false,
        state: "pending" as const,
        attempts: 0,
      };
    const tools = new TaskTools(
      config,
      f.store,
      owned,
      task,
      work,
      sandbox,
    ).all();
    await assert.rejects(
      () =>
        tools
          .find((t) => t.name === "read_file")!
          .execute(
            { path: "escape", startLine: 1, lines: 10 },
            new AbortController().signal,
          ),
      /Links/,
    );
    f.store.release(owned);
  } finally {
    await f.cleanup();
  }
});
test("coding checks execute on the integrated copy before successful apply", async (t) => {
  const config = testConfig();
  config.execution.backend = "bubblewrap";
  config.checks = {
    content: {
      command: 'test "$(cat value.txt)" = finished',
      protectedPaths: ["check-policy.txt"],
    },
  };
  const runtime = new ScriptedRuntime(async (request) => {
      await call(request, "edit_file", {
        path: "value.txt",
        oldText: "old",
        newText: "finished",
      });
      return completed(["value.txt"]);
    }),
    f = await fixture(runtime, config);
  try {
    const origin = await gitWorkspace(f.root, {
        "value.txt": "old",
        "check-policy.txt": "fixed",
      }),
      run = await f.harness.create({
        kind: "coding",
        workspace: origin,
        objective: "fix",
        checks: ["content"],
      }),
      work = join(f.store.runDir(run.id), "work");
    const probe = await new Sandbox(config.execution).probe(work);
    if (!probe.ok) {
      if (process.env.AGENT_REQUIRE_SANDBOX === "1") assert.fail(probe.detail);
      t.skip(probe.detail);
      return;
    }
    const result = await f.harness.execute(run.id);
    assert.equal(result.state, "succeeded", result.reason);
    assert.equal(await readFile(join(origin, "value.txt"), "utf8"), "old");
    const approved = JSON.parse(
      await readFile(
        join(f.store.runDir(run.id), "validated-manifest.json"),
        "utf8",
      ),
    );
    await applyFiles(f.store.runDir(run.id), approved, config);
    assert.equal(await readFile(join(origin, "value.txt"), "utf8"), "finished");
    assert.ok(
      f.store.artifacts(run.id).some((a) => a.name === "check-content.json"),
    );
  } finally {
    await f.cleanup();
  }
});

test("artifact export resolves storage aliases before writing any artifact", async () => {
  const { exportArtifacts } = await import("../src/artifacts.js");
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const alias = join(f.root, "state-alias");
    await symlink(f.p.home, alias);
    const run = await f.harness.create({
      kind: "writing",
      objective: "Export",
    });
    await assert.rejects(
      () => exportArtifacts(f.store, f.p, run.id, join(alias, "export")),
      /outside agent storage/,
    );
  } finally {
    await f.cleanup();
  }
});

test("application stops before file writes when its owner loses the lease", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const origin = await gitWorkspace(f.root, { "app.txt": "baseline" });
    const run = await f.harness.create({
      kind: "coding",
      objective: "Update",
      workspace: origin,
    });
    const directory = f.store.runDir(run.id);
    await writeFile(join(directory, "work", "app.txt"), "updated");
    const approved = await inventory(
      join(directory, "work"),
      f.config.limits.maxWorkspaceBytes,
    );
    await assert.rejects(
      () =>
        applyFiles(directory, approved, f.config, () => {
          throw new Error("lease lost");
        }),
      /lease lost/,
    );
    assert.equal(await readFile(join(origin, "app.txt"), "utf8"), "baseline");
  } finally {
    await f.cleanup();
  }
});
