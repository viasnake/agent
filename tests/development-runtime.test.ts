import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import {
  readFile,
  writeFile,
  symlink,
  mkdir,
  truncate,
} from "node:fs/promises";
import { configHash, validateConfig } from "../src/config.js";
import { normalizeConversationContext } from "../src/context.js";
import {
  developmentDirectory,
  measureDevelopmentDirectory,
} from "../src/development-runtime.js";
import { Sandbox } from "../src/sandbox.js";
import type { SandboxRuntime } from "../src/sandbox/types.js";
import { TaskTools } from "../src/tools.js";
import { inventory, workspaceDiff } from "../src/workspace.js";
import {
  fixture,
  ScriptedRuntime,
  completed,
  gitWorkspace,
  testConfig,
} from "./helpers.js";

async function developmentFixture() {
  const config = testConfig();
  config.execution.backend = "bubblewrap";
  config.execution.runtimePaths = [dirname(dirname(process.execPath))];
  config.execution.profiles = {
    install: {
      description:
        "Install the local fixture dependency offline without lifecycle scripts",
      command:
        "mkdir -p /runtime/app && cp /workspace/package.json /runtime/app/package.json && cd /runtime/app && npm install --package-lock-only --install-links --ignore-scripts --offline --no-audit --no-fund --cache /runtime/cache && npm ci --install-links --ignore-scripts --offline --no-audit --no-fund --cache /runtime/cache",
    },
    build: {
      description: "Build with the prepared dependency",
      command:
        "npm --prefix /runtime/app run build --offline > /workspace/built.txt",
    },
  };
  const f = await fixture(new ScriptedRuntime(async () => completed()), config);
  const origin = await gitWorkspace(f.root, {
    "package.json": JSON.stringify({
      name: "fixture-project",
      version: "1.0.0",
      scripts: {
        build: "node -e \"process.stdout.write(require('fixture-dep'))\"",
      },
      dependencies: { "fixture-dep": "file:/workspace/vendor" },
    }),
    "vendor/package.json": JSON.stringify({
      name: "fixture-dep",
      version: "1.0.0",
      main: "index.js",
      scripts: { install: "touch /runtime/SCRIPT_RAN" },
    }),
    "vendor/index.js": "module.exports = 'dependency-build-42';\n",
  });
  const created = await f.harness.create({
    kind: "coding",
    workspace: origin,
    objective: "Prepare dependencies and build",
    access: "change",
  });
  const run = f.store.claim(created.id);
  const root = join(f.store.runDir(run.id), "work");
  const task = {
    id: "writer",
    role: "worker" as const,
    objective: "build",
    dependsOn: [],
    write: true,
    state: "pending" as const,
    attempts: 0,
  };
  const sandbox = new Sandbox(config.execution);
  const dispatcher = new TaskTools(config, f.store, run, task, root, sandbox);
  return {
    ...f,
    run,
    root,
    origin,
    task,
    sandbox,
    dispatcher,
    cleanup: async () => {
      f.store.release(run);
      await f.cleanup();
    },
  };
}

test("development profiles preserve legacy config and enforce task/config authorization before dispatch", async (t) => {
  const legacy = testConfig();
  assert.deepEqual(validateConfig(legacy), legacy);
  assert.equal(configHash(validateConfig(legacy)), configHash(legacy));
  const f = await developmentFixture();
  try {
    let executions = 0;
    t.mock.method(f.sandbox, "execute", async () => {
      executions++;
      return { code: 0, stdout: "", stderr: "", truncated: false };
    });
    const tools = (run = f.run, task = f.task) =>
      new TaskTools(f.config, f.store, run, task, f.root, f.sandbox).all();
    assert.ok(tools().some((tool) => tool.name === "run_profile"));
    assert.ok(
      !tools({ ...f.run, access: "read-only" }).some(
        (tool) => tool.name === "run_profile",
      ),
    );
    assert.ok(
      !tools(f.run, { ...f.task, write: false }).some(
        (tool) => tool.name === "run_profile",
      ),
    );
    assert.ok(
      !new TaskTools(
        f.config,
        f.store,
        f.run,
        { ...f.task, delegatedBy: "parent" },
        f.root,
        f.sandbox,
      )
        .all()
        .some((tool) => tool.name === "run_profile"),
    );
    assert.ok(
      !new TaskTools(
        f.config,
        f.store,
        f.run,
        { ...f.task, purpose: "synthesis" },
        f.root,
        f.sandbox,
      )
        .all()
        .some((tool) => tool.name === "run_profile"),
    );
    const profile = tools().find((tool) => tool.name === "run_profile")!;
    await assert.rejects(
      () =>
        profile.execute({ profile: "unknown" }, new AbortController().signal),
      { code: "TOOL_ARGUMENTS" },
    );
    f.config.execution.profiles!.install!.command = "changed";
    await assert.rejects(
      () =>
        profile.execute({ profile: "install" }, new AbortController().signal),
      { code: "PROFILE_CONFIG" },
    );
    assert.equal(executions, 0);
    assert.equal(f.store.operations(f.run.id).at(-1)?.status, "failed");
  } finally {
    await f.cleanup();
  }
});

test("development runtime remains task/policy scoped and bounded without traversing links", async () => {
  const f = await developmentFixture();
  try {
    const runDir = f.store.runDir(f.run.id);
    const first = await developmentDirectory(runDir, f.run, f.task);
    await writeFile(join(first, "cache"), "x");
    await symlink("/etc/passwd", join(first, "link"));
    assert.equal((await measureDevelopmentDirectory(first, 100)).bytes, 12);
    assert.equal(await developmentDirectory(runDir, f.run, f.task), first);
    const reviewer = await developmentDirectory(runDir, f.run, {
      ...f.task,
      id: "reviewer",
      role: "reviewer",
      write: false,
    });
    assert.notEqual(reviewer, first);
    assert.equal((await measureDevelopmentDirectory(reviewer, 100)).entries, 0);
    f.run.contextState = {
      ...normalizeConversationContext(f.run.contextState),
      excludedSourceHashes: ["a".repeat(64)],
    };
    const excluded = await developmentDirectory(runDir, f.run, f.task);
    assert.notEqual(excluded, first);
    assert.equal((await measureDevelopmentDirectory(excluded, 100)).entries, 0);
    await writeFile(join(excluded, "large"), "x".repeat(101));
    await assert.rejects(() => measureDevelopmentDirectory(excluded, 100), {
      code: "DEVELOPMENT_SIZE",
    });
    assert.deepEqual(
      (await workspaceDiff(runDir, f.config.limits.maxWorkspaceBytes)).changes,
      [],
    );
  } finally {
    await f.cleanup();
  }
});

test("development profile and shell mount runtime with distinct write permissions", async (t) => {
  const f = await developmentFixture();
  try {
    const modes: boolean[] = [];
    t.mock.method(
      f.sandbox,
      "execute",
      async (
        _root: string,
        _command: string,
        _signal: AbortSignal,
        _readOnly = false,
        runtime?: SandboxRuntime,
      ) => {
        assert.ok(runtime);
        modes.push(runtime.readOnly);
        if (!runtime.readOnly)
          await writeFile(join(runtime.path, "prepared"), "installed");
        else
          assert.equal(
            await readFile(join(runtime.path, "prepared"), "utf8"),
            "installed",
          );
        return { code: 0, stdout: "synthetic", stderr: "", truncated: false };
      },
    );
    const tools = f.dispatcher.all();
    const profile = tools.find((tool) => tool.name === "run_profile")!;
    await profile.execute({ profile: "install" }, new AbortController().signal);
    await tools
      .find((tool) => tool.name === "shell")!
      .execute({ command: "read dependency" }, new AbortController().signal);
    assert.deepEqual(modes, [false, true]);
    assert.equal(f.store.operations(f.run.id).at(-1)?.status, "completed");
    const runtime = await developmentDirectory(
      f.store.runDir(f.run.id),
      f.run,
      f.task,
    );
    await truncate(
      join(runtime, "prepared"),
      f.config.limits.maxWorkspaceBytes + 1,
    );
    await assert.rejects(
      () =>
        profile.execute({ profile: "install" }, new AbortController().signal),
      { code: "DEVELOPMENT_SIZE" },
    );
    assert.deepEqual(modes, [false, true]);
  } finally {
    await f.cleanup();
  }
});

test("development runtime Podman mounts retain network and workspace isolation", async () => {
  const f = await developmentFixture();
  try {
    const runtime = await developmentDirectory(
      f.store.runDir(f.run.id),
      f.run,
      f.task,
    );
    const argsSeen: string[][] = [];
    const sandbox = new Sandbox(
      {
        ...f.config.execution,
        backend: "podman",
        runtimePaths: [],
        image: `localhost/test@sha256:${"a".repeat(64)}`,
      },
      "darwin",
      async (_command, args) => {
        argsSeen.push(args);
        return {
          code: 0,
          stdout: args[0] === "info" ? "true" : "",
          stderr: "",
          truncated: false,
        };
      },
    );
    for (const readOnly of [false, true])
      await sandbox.execute(
        f.root,
        "true",
        new AbortController().signal,
        false,
        { path: runtime, readOnly },
      );
    const runs = argsSeen.filter((args) => args[0] === "run");
    assert.equal(runs.length, 2);
    for (const [index, args] of runs.entries()) {
      assert.ok(args.includes("--network=none"));
      assert.ok(args.includes("--pull=never"));
      assert.ok(
        args.some((arg) => arg.endsWith(`:/runtime:${index ? "ro" : "rw"}`)),
      );
    }
    await assert.rejects(
      () =>
        sandbox.execute(f.root, "true", new AbortController().signal, false, {
          path: f.root,
          readOnly: false,
        }),
      { code: "SANDBOX" },
    );
  } finally {
    await f.cleanup();
  }
});

test("real Linux development profile installs offline dependencies and builds across isolated calls", async (t) => {
  if (process.platform !== "linux")
    return t.skip(
      "Bubblewrap integration is Linux-only; Podman arguments are tested separately",
    );
  const f = await developmentFixture();
  try {
    const probe = await f.sandbox.probe(f.root);
    if (!probe.ok) {
      if (process.env.AGENT_REQUIRE_SANDBOX === "1") assert.fail(probe.detail);
      return t.skip(probe.detail);
    }
    const tools = f.dispatcher.all();
    const profile = tools.find((tool) => tool.name === "run_profile")!;
    const execute = (name: string) =>
      profile
        .execute({ profile: name }, new AbortController().signal)
        .then((output) => JSON.parse(output));
    const installed = await execute("install");
    assert.equal(installed.code, 0, installed.stderr);
    assert.equal((await execute("build")).code, 0);
    assert.match(
      await readFile(join(f.root, "built.txt"), "utf8"),
      /dependency-build-42/,
    );
    const shell = tools.find((tool) => tool.name === "shell")!;
    const result = JSON.parse(
      await shell.execute(
        {
          command:
            "test ! -e /runtime/SCRIPT_RAN && node -p \"require('/runtime/app/node_modules/fixture-dep')\"",
        },
        new AbortController().signal,
      ),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "dependency-build-42");
    const denied = JSON.parse(
      await shell.execute(
        { command: "touch /runtime/denied" },
        new AbortController().signal,
      ),
    );
    assert.notEqual(denied.code, 0);
    assert.deepEqual(
      (
        await workspaceDiff(
          f.store.runDir(f.run.id),
          f.config.limits.maxWorkspaceBytes,
        )
      ).changes.map((change) => change.path),
      ["built.txt"],
    );
    await assert.rejects(() => readFile(join(f.origin, "built.txt")), {
      code: "ENOENT",
    });
    await mkdir(join(f.root, "node_modules"));
    await assert.rejects(
      () => inventory(f.root, f.config.limits.maxWorkspaceBytes),
      { code: "WORKSPACE_CONTENT" },
    );
  } finally {
    await f.cleanup();
  }
});
