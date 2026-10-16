import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  writeFile,
  readFile,
  lstat,
  mkdir,
  symlink,
  chmod,
  readdir,
} from "node:fs/promises";
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
import { sha256 } from "../src/util.js";
import { Evaluator } from "../src/validation.js";

test("Harness attachment count and raw bytes are preflighted before storage", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const paths = Array.from({ length: 9 }, (_, index) =>
      join(f.root, `small-${index}.txt`),
    );
    for (const path of paths) await writeFile(path, "a");
    await assert.rejects(
      f.harness.create({
        kind: "chat",
        objective: "inspect",
        inputs: paths,
      }),
      { code: "INPUT_SIZE" },
    );
    await readdir(f.p.attachments).then(
      () => assert.fail("over-count input created attachment storage"),
      (error: NodeJS.ErrnoException) => assert.equal(error.code, "ENOENT"),
    );

    const large = [join(f.root, "large-a.txt"), join(f.root, "large-b.txt")];
    for (const path of large)
      await writeFile(path, Buffer.alloc(10_000_001, 0x61));
    await assert.rejects(
      f.harness.create({
        kind: "chat",
        objective: "inspect",
        inputs: large,
      }),
      { code: "INPUT_SIZE" },
    );
    await readdir(f.p.attachments).then(
      () => assert.fail("over-budget input created attachment storage"),
      (error: NodeJS.ErrnoException) => assert.equal(error.code, "ENOENT"),
    );
  } finally {
    await f.cleanup();
  }
});

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
test("redacted originals stay out of continued tool work and cannot be reapplied", async () => {
  const runtime = new ScriptedRuntime(async () => "read-only answer"),
    f = await fixture(runtime);
  try {
    const original = "same image bytes\n",
      origin = await gitWorkspace(f.root, {
        "assets/original.png": original,
        "assets/alias.png": original,
        "README.md": "safe\n",
      }),
      run = await f.harness.create({
        kind: "chat",
        access: "read-only",
        objective: "inspect workspace",
        workspace: origin,
        redactedImageHashes: [sha256(original)],
      }),
      directory = f.store.runDir(run.id),
      snapshot = await readSnapshot(directory);
    assert.deepEqual(snapshot.redactedPaths, [
      "assets/alias.png",
      "assets/original.png",
    ]);
    assert.ok(snapshot.files["assets/original.png"]);
    assert.ok(snapshot.files["assets/alias.png"]);
    await assert.rejects(
      readFile(join(directory, "work", "assets/original.png")),
      { code: "ENOENT" },
    );
    assert.deepEqual(
      await workspaceDiff(directory, f.config.limits.maxWorkspaceBytes),
      { changes: [], patch: "" },
    );

    const owned = f.store.claim(run.id, true, true),
      task = {
        id: "inspect",
        objective: "inspect",
        role: "worker" as const,
        dependsOn: [],
        write: false,
        state: "pending" as const,
        attempts: 0,
      },
      tools = new TaskTools(
        f.config,
        f.store,
        owned,
        task,
        join(directory, "work"),
        new Sandbox(f.config.execution),
      ).all();
    try {
      for (const path of ["assets/original.png", "assets//original.png"])
        await assert.rejects(
          () =>
            tools
              .find((tool) => tool.name === "read_file")!
              .execute(
                { path, startLine: 1, lines: 10 },
                new AbortController().signal,
              ),
          { code: "IMAGE_REDACTED" },
        );
      const aliasedWork = join(directory, "work-alias");
      await symlink(join(directory, "work"), aliasedWork, "dir");
      const aliasedTools = new TaskTools(
        f.config,
        f.store,
        owned,
        task,
        aliasedWork,
        new Sandbox(f.config.execution),
      ).all();
      await assert.rejects(
        () =>
          aliasedTools
            .find((tool) => tool.name === "read_file")!
            .execute(
              { path: "assets/original.png", startLine: 1, lines: 10 },
              new AbortController().signal,
            ),
        { code: "IMAGE_REDACTED" },
      );
    } finally {
      f.store.release(owned);
    }

    await mkdir(join(directory, "work", "assets"), { recursive: true });
    await writeFile(join(directory, "work", "assets/original.png"), original);
    await writeFile(
      join(directory, "work", "assets/copied-alias.png"),
      original,
    );
    const continued = await f.harness.create({
        kind: "chat",
        access: "read-only",
        objective: "continue inspecting workspace",
        workspace: origin,
        parentRunId: run.id,
        redactedImageHashes: [sha256(original)],
      }),
      continuedDirectory = f.store.runDir(continued.id),
      continuedSnapshot = await readSnapshot(continuedDirectory);
    assert.ok(
      continuedSnapshot.redactedPaths?.includes("assets/copied-alias.png"),
    );
    await assert.rejects(
      readFile(join(continuedDirectory, "work", "assets/original.png")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      readFile(join(continuedDirectory, "work", "assets/copied-alias.png")),
      { code: "ENOENT" },
    );
    assert.deepEqual(
      await workspaceDiff(
        continuedDirectory,
        f.config.limits.maxWorkspaceBytes,
      ),
      { changes: [], patch: "" },
    );

    await writeFile(
      join(continuedDirectory, "work", "assets/original.png"),
      original,
    );
    await assert.rejects(
      workspaceDiff(continuedDirectory, f.config.limits.maxWorkspaceBytes),
      { code: "IMAGE_REDACTED" },
    );
    const reintroduced = await inventory(
      join(continuedDirectory, "work"),
      f.config.limits.maxWorkspaceBytes,
    );
    await assert.rejects(
      applyFiles(continuedDirectory, reintroduced, f.config),
      { code: "IMAGE_REDACTED" },
    );
  } finally {
    await f.cleanup();
  }
});

test("applying safe edits preserves projected image aliases and baseline bytes", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "read-only answer"));
  try {
    const image = "private image payload\n",
      origin = await gitWorkspace(f.root, {
        "assets/original.png": image,
        "assets/alias.png": image,
        "README.md": "before\n",
      }),
      run = await f.harness.create({
        kind: "chat",
        access: "read-only",
        objective: "inspect",
        workspace: origin,
        redactedImageHashes: [sha256(image)],
      }),
      directory = f.store.runDir(run.id);
    await writeFile(join(directory, "work", "README.md"), "after\n");
    await applyFiles(
      directory,
      await inventory(
        join(directory, "work"),
        f.config.limits.maxWorkspaceBytes,
      ),
      f.config,
    );
    for (const path of ["assets/original.png", "assets/alias.png"]) {
      assert.equal(await readFile(join(origin, path), "utf8"), image);
      assert.equal(
        await readFile(join(directory, "baseline", path), "utf8"),
        image,
      );
    }
    assert.equal(await readFile(join(origin, "README.md"), "utf8"), "after\n");
  } finally {
    await f.cleanup();
  }
});

test("required protected inputs excluded by image redaction have an explicit diagnostic", async () => {
  const config = testConfig(),
    runtime = new ScriptedRuntime(async () => completed());
  config.checks.protected = {
    command: "false",
    protectedPaths: ["assets"],
  };
  const f = await fixture(runtime, config);
  try {
    const image = "redacted protected input\n",
      origin = await gitWorkspace(f.root, {
        "assets/policy.png": image,
        "README.md": "safe\n",
      }),
      run = await f.harness.create({
        kind: "coding",
        workspace: origin,
        objective: "update the readme",
        checks: ["protected"],
        redactedImageHashes: [sha256(image)],
      });
    await assert.rejects(
      new Evaluator(config, f.store, new Sandbox(config.execution)).validate(
        run,
        new AbortController().signal,
      ),
      {
        code: "IMAGE_REDACTED",
        message: /Required check input was excluded by image redaction/,
      },
    );
    assert.equal(runtime.requests.length, 0);
    assert.equal(f.store.operations(run.id).length, 0);
  } finally {
    await f.cleanup();
  }
});
test("read-only snapshots reject widened disclosure and unresolved source operations before copying", async () => {
  const runtime = new ScriptedRuntime(async () => completed());
  const f = await fixture(runtime);
  try {
    const origin = await gitWorkspace(f.root, { "app.txt": "baseline" });
    const restricted = await f.harness.create({
      kind: "coding",
      objective: "restricted source",
      workspace: origin,
      dataClass: "restricted",
    });
    const localOnly = await f.harness.create({
      kind: "coding",
      objective: "local-only source",
      workspace: origin,
      localOnly: true,
    });
    const unresolved = await f.harness.create({
      kind: "coding",
      objective: "pending operation source",
      workspace: origin,
    });
    const claimed = f.store.claim(unresolved.id);
    const operation = f.store.prepare(claimed, "work", "write_file", {});
    f.store.operation(claimed, operation, "dispatched");
    f.store.release(claimed);
    const before = f.store.list().length;

    await assert.rejects(
      () =>
        f.harness.create({
          kind: "chat",
          access: "read-only",
          objective: "inspect restricted source",
          workspace: origin,
          snapshotRunId: restricted.id,
          dataClass: "private",
        }),
      { code: "DISCLOSURE_DENIED" },
    );
    await assert.rejects(
      () =>
        f.harness.create({
          kind: "chat",
          access: "read-only",
          objective: "inspect local-only source",
          workspace: origin,
          snapshotRunId: localOnly.id,
        }),
      { code: "DISCLOSURE_DENIED" },
    );
    await assert.rejects(
      () =>
        f.harness.create({
          kind: "chat",
          access: "read-only",
          objective: "inspect unresolved source",
          workspace: origin,
          snapshotRunId: unresolved.id,
        }),
      { code: "UNKNOWN_OPERATION" },
    );
    assert.equal(f.store.list().length, before);
    assert.equal(runtime.requests.length, 0);
  } finally {
    await f.cleanup();
  }
});
test("snapshot ids require read-only access and cannot accompany a parent", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const origin = await gitWorkspace(f.root, { "app.txt": "baseline" });
    const source = await f.harness.create({
      kind: "coding",
      objective: "source",
      workspace: origin,
    });
    const before = f.store.list().length;
    await assert.rejects(
      () =>
        f.harness.create({
          kind: "chat",
          access: "change",
          objective: "write after snapshot",
          workspace: origin,
          snapshotRunId: source.id,
        }),
      { code: "CONTINUATION" },
    );
    await assert.rejects(
      () =>
        f.harness.create({
          kind: "chat",
          access: "read-only",
          objective: "ambiguous lineage",
          workspace: origin,
          parentRunId: source.id,
          snapshotRunId: source.id,
        }),
      { code: "CONTINUATION" },
    );
    assert.equal(f.store.list().length, before);
  } finally {
    await f.cleanup();
  }
});
test("legacy runs infer persisted access from their original kind on get and claim", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const workspace = await gitWorkspace(f.root, { "app.txt": "baseline" });
    const chat = await f.harness.create({
      kind: "chat",
      objective: "old chat",
    });
    const coding = await f.harness.create({
      kind: "coding",
      objective: "old coding",
      workspace,
    });
    for (const run of [chat, coding]) {
      const legacy = { ...run };
      delete legacy.access;
      f.store.db
        .prepare("UPDATE runs SET payload=? WHERE id=?")
        .run(JSON.stringify(legacy), run.id);
    }

    assert.equal(f.store.get(chat.id).access, "read-only");
    assert.equal(f.store.get(coding.id).access, "change");
    const claimedChat = f.store.claim(chat.id);
    assert.equal(claimedChat.access, "read-only");
    f.store.release(claimedChat);
    const claimedCoding = f.store.claim(coding.id);
    assert.equal(claimedCoding.access, "change");
    f.store.release(claimedCoding);
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
