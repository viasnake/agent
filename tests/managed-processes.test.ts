import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configHash, paths } from "../src/config.js";
import { Harness } from "../src/harness.js";
import { McpTools } from "../src/mcp.js";
import {
  ManagedProcesses,
  processToolAllowed,
  provisionManagedProcessAnchor,
} from "../src/managed-processes.js";
import { runProcess } from "../src/process.js";
import { Store } from "../src/storage.js";
import { TaskExecutor } from "../src/task-executor.js";
import { Sandbox } from "../src/sandbox.js";
import { TaskTools } from "../src/tools.js";
import {
  completed,
  fixture,
  gitWorkspace,
  ScriptedRuntime,
  testConfig,
} from "./helpers.js";

const anchorId = "a".repeat(64);

test("anchor provisioning is explicit and does not mutate configuration", async () => {
  const config = testConfig();
  config.execution.backend = "podman";
  config.execution.image = `fixture@sha256:${"b".repeat(64)}`;
  const before = configHash(config);
  const calls: string[][] = [];
  const result = await provisionManagedProcessAnchor(
    config,
    async (_command, args) => {
      calls.push(args);
      if (args[0] === "info")
        return { code: 0, stdout: "true\n", stderr: "", truncated: false };
      return { code: 0, stdout: `${anchorId}\n`, stderr: "", truncated: false };
    },
  );
  assert.equal(configHash(config), before);
  assert.equal(result.containerId, anchorId);
  const create = calls.find((args) => args[0] === "create")!;
  assert.match(create.join(" "), /--network=none/);
  assert.match(create.join(" "), /--read-only/);
  assert.doesNotMatch(create.join(" "), /run|--rm/);
});

test("managed identity is written before container creation", async () => {
  const config = testConfig();
  config.execution.backend = "podman";
  config.execution.image = `fixture@sha256:${"b".repeat(64)}`;
  config.execution.managedProcesses = {
    engineAnchor: {
      containerId: anchorId,
      token: "00000000-0000-4000-8000-000000000000",
    },
    maxSeconds: 60,
    maxProcesses: 1,
  };
  const f = await fixture(new ScriptedRuntime(async () => completed()), config);
  try {
    const origin = await gitWorkspace(f.root, { "README.md": "fixture\n" });
    const created = await f.harness.create({
      kind: "coding",
      objective: "managed process",
      workspace: origin,
      access: "change",
    });
    const run = f.store.claim(created.id);
    const task = {
      id: "writer",
      role: "worker" as const,
      objective: "run bounded process",
      dependsOn: [],
      write: true,
      state: "pending" as const,
      attempts: 0,
    };
    const operation = f.store.prepare(run, task.id, "process_start", {
      command: "printf ok",
    });
    const calls: string[][] = [];
    let createdRecord = false;
    const manager = new ManagedProcesses(
      config,
      f.store,
      run,
      task,
      async (_command, args) => {
        calls.push(args);
        if (args[0] === "info")
          return { code: 0, stdout: "true\n", stderr: "", truncated: false };
        if (args[0] === "inspect") {
          const hasJob = calls.some((entry) => entry[0] === "create");
          const anchor = {
            Id: anchorId,
            Config: {
              Labels: {
                "local-agent.process-anchor":
                  config.execution.managedProcesses!.engineAnchor.token,
              },
            },
          };
          if (!hasJob)
            return {
              code: 0,
              stdout: JSON.stringify([anchor]),
              stderr: "",
              truncated: false,
            };
          createdRecord = true;
          return {
            code: 1,
            stdout: JSON.stringify([anchor]),
            stderr: `no such container local-agent-process-${operation}`,
            truncated: false,
          };
        }
        if (args[0] === "create") {
          const recordPath = join(
            f.store.runDir(run.id),
            "managed-processes",
            `${operation}.json`,
          );
          await readFile(recordPath);
          assert.equal(createdRecord, false);
          return {
            code: 0,
            stdout: `${"c".repeat(64)}\n`,
            stderr: "",
            truncated: false,
          };
        }
        throw new Error(`unexpected podman call: ${args.join(" ")}`);
      },
    );
    await manager.prepare(task, operation, "printf ok");
    f.store.operation(run, operation, "dispatched");
    await assert.rejects(() =>
      manager.start(task, operation, "printf ok", new AbortController().signal),
    );
  } finally {
    await f.cleanup();
  }
});

test("cancellation between create and start leaves a cleanable identity", async () => {
  const config = testConfig();
  config.execution.backend = "podman";
  config.execution.image = `fixture@sha256:${"b".repeat(64)}`;
  config.execution.managedProcesses = {
    engineAnchor: {
      containerId: anchorId,
      token: "00000000-0000-4000-8000-000000000000",
    },
    maxSeconds: 60,
    maxProcesses: 1,
  };
  const f = await fixture(new ScriptedRuntime(async () => completed()), config);
  try {
    const origin = await gitWorkspace(f.root, { "README.md": "fixture\n" });
    const created = await f.harness.create({
      kind: "coding",
      objective: "cancel process start",
      workspace: origin,
      access: "change",
    });
    const run = f.store.claim(created.id);
    const task = {
      id: "writer",
      role: "worker" as const,
      objective: "writer",
      dependsOn: [],
      write: true,
      state: "pending" as const,
      attempts: 0,
    };
    const command = "printf should-not-start";
    const operation = f.store.prepare(run, task.id, "process_start", {
      command,
    });
    const processId = "c".repeat(64);
    const controller = new AbortController();
    let jobToken = "";
    let exists = false;
    let started = false;
    let removed = false;
    const runner = async (_command: string, args: string[]) => {
      if (args[0] === "info")
        return { code: 0, stdout: "true\n", stderr: "", truncated: false };
      if (args[0] === "inspect") {
        const target = args[3];
        const anchor = {
          Id: anchorId,
          Config: {
            Labels: {
              "local-agent.process-anchor":
                config.execution.managedProcesses!.engineAnchor.token,
            },
          },
        };
        const job = {
          Id: processId,
          Name: `local-agent-process-${operation}`,
          Config: {
            Labels: {
              "local-agent.process-token": jobToken,
              "local-agent.process-run": run.id,
              "local-agent.process-task": task.id,
              "local-agent.process-operation": operation,
            },
          },
          State: { Status: started ? "running" : "created", ExitCode: 0 },
        };
        if (target && exists)
          return {
            code: 0,
            stdout: JSON.stringify([anchor, job]),
            stderr: "",
            truncated: false,
          };
        return {
          code: target ? 1 : 0,
          stdout: JSON.stringify([anchor]),
          stderr: target ? `no such container ${target}` : "",
          truncated: false,
        };
      }
      if (args[0] === "create") {
        exists = true;
        jobToken = args
          .find((arg) => arg.startsWith("--label=local-agent.process-token="))!
          .split("=")
          .at(-1)!;
        controller.abort();
        return {
          code: 0,
          stdout: `${processId}\n`,
          stderr: "",
          truncated: false,
        };
      }
      if (args[0] === "start") {
        started = true;
        return { code: 0, stdout: "", stderr: "", truncated: false };
      }
      if (args[0] === "rm") {
        exists = false;
        removed = true;
        return { code: 0, stdout: "", stderr: "", truncated: false };
      }
      throw new Error(`unexpected podman call: ${args.join(" ")}`);
    };
    const manager = new ManagedProcesses(config, f.store, run, task, runner);
    await manager.prepare(task, operation, command);
    f.store.operation(run, operation, "dispatched");
    await assert.rejects(
      () => manager.start(task, operation, command, controller.signal),
      { name: "AbortError" },
    );
    assert.equal(started, false);
    assert.equal(
      f.store.operations(run.id).find((entry) => entry.id === operation)
        ?.status,
      "unknown",
    );
    await manager.stop(operation);
    assert.equal(removed, true);
    assert.equal(
      f.store.operations(run.id).find((entry) => entry.id === operation)
        ?.status,
      "completed",
    );
    const missingFileOperation = f.store.prepare(
      run,
      task.id,
      "process_start",
      { command: "printf missing-file" },
    );
    const corruptOperation = f.store.prepare(run, task.id, "process_start", {
      command: "printf corrupt-file",
    });
    const managedDirectory = join(f.store.runDir(run.id), "managed-processes");
    await writeFile(
      join(managedDirectory, `${corruptOperation}.json`),
      "{corrupt",
    );
    const missingFileEntry = (await manager.list()).find(
      (entry) => entry.processId === missingFileOperation,
    );
    assert.deepEqual(missingFileEntry, {
      processId: missingFileOperation,
      taskId: task.id,
      phase: "unknown",
      lifecycle: "prepared",
      status: "cleanup-unresolved",
    });
    const corruptEntry = (await manager.list()).find(
      (entry) => entry.processId === corruptOperation,
    );
    assert.deepEqual(corruptEntry, {
      processId: corruptOperation,
      taskId: task.id,
      phase: "unknown",
      lifecycle: "prepared",
      status: "cleanup-unresolved",
    });
    await rm(managedDirectory, { recursive: true, force: true });
    const missingDirectoryEntry = (await manager.list()).find(
      (entry) => entry.processId === missingFileOperation,
    );
    assert.deepEqual(missingDirectoryEntry, missingFileEntry);
  } finally {
    await f.cleanup();
  }
});

test("managed lifecycle stays dispatched until verified cleanup", async () => {
  const config = testConfig();
  config.execution.backend = "podman";
  config.execution.image = `fixture@sha256:${"b".repeat(64)}`;
  config.execution.managedProcesses = {
    engineAnchor: {
      containerId: anchorId,
      token: "00000000-0000-4000-8000-000000000000",
    },
    maxSeconds: 60,
    maxProcesses: 1,
  };
  const f = await fixture(new ScriptedRuntime(async () => completed()), config);
  try {
    const origin = await gitWorkspace(f.root, { "README.md": "fixture\n" });
    const created = await f.harness.create({
      kind: "coding",
      objective: "managed process",
      workspace: origin,
      access: "change",
    });
    const run = f.store.claim(created.id);
    const task = {
      id: "writer",
      role: "worker" as const,
      objective: "run bounded process",
      dependsOn: [],
      write: true,
      state: "pending" as const,
      attempts: 0,
    };
    const operation = f.store.prepare(run, task.id, "process_start", {
      command: "printf managed",
    });
    const processId = "c".repeat(64);
    const name = `local-agent-process-${operation}`;
    let exists = false;
    let started = false;
    let inspectedExitCode = 0;
    let anchorToken = config.execution.managedProcesses!.engineAnchor.token;
    let jobToken = "";
    let rmArgs: string[] | undefined;
    let createArgs: string[] | undefined;
    let omitAnchor = false;
    let inspectError: string | undefined;
    let throwOnRm = false;
    let logsArgs: string[] | undefined;
    const runner = async (_command: string, args: string[]) => {
      if (args[0] === "info")
        return { code: 0, stdout: "true\n", stderr: "", truncated: false };
      if (args[0] === "inspect") {
        const target = args[3];
        const anchor = {
          Id: anchorId,
          Config: { Labels: { "local-agent.process-anchor": anchorToken } },
        };
        const job = {
          Id: processId,
          Name: name,
          Config: {
            Labels: {
              "local-agent.process-token": jobToken,
              "local-agent.process-run": run.id,
              "local-agent.process-task": task.id,
              "local-agent.process-operation": operation,
            },
          },
          State: {
            Status:
              inspectedExitCode === -1
                ? "exited"
                : started
                  ? "running"
                  : "created",
            ExitCode: inspectedExitCode,
          },
        };
        if (target && exists)
          return {
            code: 0,
            stdout: JSON.stringify([...(omitAnchor ? [] : [anchor]), job]),
            stderr: "",
            truncated: false,
          };
        return {
          code: target ? 1 : 0,
          stdout: JSON.stringify(omitAnchor ? [] : [anchor]),
          stderr: target ? (inspectError ?? `no such container ${target}`) : "",
          truncated: false,
        };
      }
      if (args[0] === "create") {
        createArgs = args;
        const recordPath = join(
          f.store.runDir(run.id),
          "managed-processes",
          `${operation}.json`,
        );
        await readFile(recordPath);
        exists = true;
        jobToken = args
          .find((arg) => arg.startsWith("--label=local-agent.process-token="))!
          .split("=")
          .at(-1)!;
        return {
          code: 0,
          stdout: `${processId}\n`,
          stderr: "",
          truncated: false,
        };
      }
      if (args[0] === "start") {
        started = true;
        return { code: 0, stdout: "", stderr: "", truncated: false };
      }
      if (args[0] === "logs") {
        logsArgs = args;
        return {
          code: 0,
          stdout: "managed log\n",
          stderr: "",
          truncated: false,
        };
      }
      if (args[0] === "rm") {
        rmArgs = args;
        if (throwOnRm) throw new Error("synthetic removal failure");
        exists = false;
        return { code: 0, stdout: "", stderr: "", truncated: false };
      }
      throw new Error(`unexpected podman call: ${args.join(" ")}`);
    };
    const manager = new ManagedProcesses(config, f.store, run, task, runner);
    await manager.prepare(task, operation, "printf managed");
    f.store.operation(run, operation, "dispatched");
    const result = await manager.start(
      task,
      operation,
      "printf managed",
      new AbortController().signal,
    );
    assert.equal(result.status, "running");
    assert.equal(
      f.store.operations(run.id).find((entry) => entry.id === operation)
        ?.status,
      "dispatched",
    );
    assert.equal(createArgs?.at(-1), "printf managed");
    for (const flag of [
      "--network=none",
      "--read-only",
      "--read-only-tmpfs=false",
      "--image-volume=ignore",
      "--cap-drop=ALL",
      "--pids-limit=128",
      "--memory=2g",
      "--cpus=2",
      "--shm-size=16m",
      "--tmpfs=/tmp:rw,nosuid,nodev,size=64m",
      "--log-driver=k8s-file",
      "--timeout=60",
    ])
      assert.ok(createArgs?.includes(flag), `missing ${flag}`);
    assert.ok(createArgs?.some((arg) => arg.endsWith(":/workspace:ro")));
    const recordPath = join(
      f.store.runDir(run.id),
      "managed-processes",
      `${operation}.json`,
    );
    const beforeRead = await readFile(recordPath);
    const ambiguous = JSON.parse(beforeRead.toString()) as {
      containerId?: string;
      phase: string;
    };
    delete ambiguous.containerId;
    ambiguous.phase = "intent";
    await writeFile(recordPath, JSON.stringify(ambiguous));
    const descriptorBeforeQueries = await readFile(recordPath);
    const recoveredStatus = await manager.status(operation);
    assert.equal(recoveredStatus.containerId, processId);
    assert.deepEqual(await manager.logs(operation), {
      processId: operation,
      output: "managed log\n",
      truncated: false,
    });
    assert.deepEqual(logsArgs, ["logs", "--tail=200", processId]);
    inspectedExitCode = -1;
    assert.deepEqual(await manager.logs(operation), {
      processId: operation,
      output: "managed log\n",
      truncated: false,
    });
    assert.deepEqual(await manager.status(operation), {
      processId: operation,
      status: "exited",
      containerId: processId,
      exitCode: -1,
    });
    inspectedExitCode = 0;
    assert.deepEqual(await readFile(recordPath), descriptorBeforeQueries);
    await writeFile(recordPath, beforeRead);
    assert.equal(
      JSON.stringify(await manager.status(operation)).includes("running"),
      true,
    );
    assert.deepEqual(await manager.logs(operation), {
      processId: operation,
      output: "managed log\n",
      truncated: false,
    });
    assert.deepEqual(await readFile(recordPath), beforeRead);
    assert.throws(() => f.store.assertManagedProcessesStopped(run), {
      code: "PROCESS_CLEANUP_REQUIRED",
    });

    exists = false;
    omitAnchor = true;
    await assert.rejects(() => manager.status(operation));
    omitAnchor = false;
    inspectError = `cannot find mount for ${name}`;
    await assert.rejects(() => manager.status(operation));
    inspectError = undefined;
    exists = true;

    anchorToken = "10000000-0000-4000-8000-000000000000";
    await assert.rejects(() => manager.stop(operation));
    assert.equal(rmArgs, undefined);
    assert.equal(
      f.store.operations(run.id).find((entry) => entry.id === operation)
        ?.status,
      "unknown",
    );
    anchorToken = config.execution.managedProcesses!.engineAnchor.token;
    throwOnRm = true;
    await assert.rejects(
      () => manager.stop(operation),
      /synthetic removal failure/,
    );
    throwOnRm = false;
    const blockedStart = f.store.prepare(run, task.id, "process_start", {
      command: "printf blocked",
    });
    await assert.rejects(
      () => manager.prepare(task, blockedStart, "printf blocked"),
      { code: "PROCESS_CLEANUP_REQUIRED" },
    );
    f.store.operation(run, blockedStart, "failed");
    await manager.stop(operation);
    assert.deepEqual(rmArgs, ["rm", "--force", processId]);
    assert.equal(
      f.store.operations(run.id).find((entry) => entry.id === operation)
        ?.status,
      "completed",
    );
    assert.doesNotThrow(() => f.store.assertManagedProcessesStopped(run));
    f.store.operation(run, operation, "unknown");
    let contactedEngine = false;
    const changedConfig = structuredClone(config);
    changedConfig.execution.backend = "bubblewrap";
    changedConfig.execution.managedProcesses = undefined;
    const recovered = new ManagedProcesses(
      changedConfig,
      f.store,
      run,
      task,
      async () => {
        contactedEngine = true;
        throw new Error("engine must not be contacted");
      },
    );
    assert.deepEqual(await recovered.status(operation), {
      processId: operation,
      status: "removed",
    });
    await recovered.stop(operation);
    assert.equal(contactedEngine, false);
    assert.equal(
      f.store.operations(run.id).find((entry) => entry.id === operation)
        ?.status,
      "completed",
    );
  } finally {
    await f.cleanup();
  }
});

test("managed cleanup refuses a lost lease before rm", async () => {
  const config = testConfig();
  config.execution.backend = "podman";
  config.execution.image = `fixture@sha256:${"b".repeat(64)}`;
  config.execution.managedProcesses = {
    engineAnchor: {
      containerId: anchorId,
      token: "00000000-0000-4000-8000-000000000000",
    },
    maxSeconds: 60,
    maxProcesses: 1,
  };
  const f = await fixture(new ScriptedRuntime(async () => completed()), config);
  try {
    const origin = await gitWorkspace(f.root, { "README.md": "fixture\n" });
    const created = await f.harness.create({
      kind: "coding",
      objective: "verify lease-bound cleanup",
      workspace: origin,
      access: "change",
    });
    const run = f.store.claim(created.id);
    const task = {
      id: "writer",
      role: "worker" as const,
      objective: "run bounded process",
      dependsOn: [],
      write: true,
      state: "pending" as const,
      attempts: 0,
    };
    const command = "printf managed";
    const operation = f.store.prepare(run, task.id, "process_start", {
      command,
    });
    const processId = "d".repeat(64);
    const name = `local-agent-process-${operation}`;
    let exists = false;
    let started = false;
    let jobToken = "";
    let loseLeaseBeforeRm = false;
    let rmArgs: string[] | undefined;
    const runner = async (_command: string, args: string[]) => {
      if (args[0] === "info")
        return { code: 0, stdout: "true\n", stderr: "", truncated: false };
      if (args[0] === "inspect") {
        const target = args[3];
        const anchor = {
          Id: anchorId,
          Config: {
            Labels: {
              "local-agent.process-anchor":
                config.execution.managedProcesses!.engineAnchor.token,
            },
          },
        };
        const job = {
          Id: processId,
          Name: name,
          Config: {
            Labels: {
              "local-agent.process-token": jobToken,
              "local-agent.process-run": run.id,
              "local-agent.process-task": task.id,
              "local-agent.process-operation": operation,
            },
          },
          State: { Status: started ? "running" : "created", ExitCode: 0 },
        };
        if (target && exists) {
          if (loseLeaseBeforeRm) {
            loseLeaseBeforeRm = false;
            f.store.release(run);
          }
          return {
            code: 0,
            stdout: JSON.stringify([anchor, job]),
            stderr: "",
            truncated: false,
          };
        }
        return {
          code: target ? 1 : 0,
          stdout: JSON.stringify([anchor]),
          stderr: target ? `no such container ${target}` : "",
          truncated: false,
        };
      }
      if (args[0] === "create") {
        await readFile(
          join(
            f.store.runDir(run.id),
            "managed-processes",
            `${operation}.json`,
          ),
        );
        exists = true;
        jobToken = args
          .find((arg) => arg.startsWith("--label=local-agent.process-token="))!
          .split("=")
          .at(-1)!;
        return {
          code: 0,
          stdout: `${processId}\n`,
          stderr: "",
          truncated: false,
        };
      }
      if (args[0] === "start") {
        started = true;
        return { code: 0, stdout: "", stderr: "", truncated: false };
      }
      if (args[0] === "rm") {
        rmArgs = args;
        exists = false;
        return { code: 0, stdout: "", stderr: "", truncated: false };
      }
      throw new Error(`unexpected podman call: ${args.join(" ")}`);
    };
    const manager = new ManagedProcesses(config, f.store, run, task, runner);
    await manager.prepare(task, operation, command);
    f.store.operation(run, operation, "dispatched");
    await manager.start(task, operation, command, new AbortController().signal);

    loseLeaseBeforeRm = true;
    await assert.rejects(() => manager.stop(operation), {
      code: "STALE_ATTEMPT",
    });
    assert.equal(rmArgs, undefined);
    assert.equal(
      f.store.operations(run.id).find((entry) => entry.id === operation)
        ?.status,
      "dispatched",
    );

    const freshRun = f.store.claim(run.id);
    const freshManager = new ManagedProcesses(
      config,
      f.store,
      freshRun,
      task,
      runner,
    );
    await freshManager.stop(operation);
    assert.deepEqual(rmArgs, ["rm", "--force", processId]);
    assert.equal(
      f.store.operations(run.id).find((entry) => entry.id === operation)
        ?.status,
      "completed",
    );
  } finally {
    await f.cleanup();
  }
});

test("TaskExecutor finally cleans a dispatched process after cancellation", async () => {
  const config = testConfig();
  config.execution.backend = "podman";
  config.execution.image = `fixture@sha256:${"b".repeat(64)}`;
  config.execution.managedProcesses = {
    engineAnchor: {
      containerId: anchorId,
      token: "00000000-0000-4000-8000-000000000000",
    },
    maxSeconds: 60,
    maxProcesses: 1,
  };
  const controller = new AbortController();
  const runtime = {
    async run(request: {
      tools: Array<{
        name: string;
        execute(
          args: Record<string, unknown>,
          signal: AbortSignal,
        ): Promise<string>;
      }>;
      signal: AbortSignal;
    }) {
      const tool = request.tools.find(
        (entry) => entry.name === "process_start",
      );
      assert.ok(tool);
      await tool.execute({ command: "sleep 30" }, request.signal);
      controller.abort();
      throw new Error("synthetic provider failure after cancellation");
    },
    async close() {},
  };
  const f = await fixture(runtime as never, config);
  try {
    const origin = await gitWorkspace(f.root, { "README.md": "fixture\n" });
    const created = await f.harness.create({
      kind: "coding",
      objective: "managed process",
      workspace: origin,
      access: "change",
    });
    const run = f.store.claim(created.id);
    const task = {
      id: "writer",
      role: "worker" as const,
      objective: "run bounded process",
      dependsOn: [],
      model: "worker",
      write: true,
      state: "pending" as const,
      attempts: 0,
    };
    run.tasks = [task];
    const processId = "d".repeat(64);
    let operationId = "";
    let exists = false;
    let started = false;
    let jobToken = "";
    let removed = false;
    const runner = async (_command: string, args: string[]) => {
      if (args[0] === "info")
        return { code: 0, stdout: "true\n", stderr: "", truncated: false };
      if (args[0] === "inspect") {
        const target = args[3];
        const anchor = {
          Id: anchorId,
          Config: {
            Labels: {
              "local-agent.process-anchor":
                config.execution.managedProcesses!.engineAnchor.token,
            },
          },
        };
        const job = {
          Id: processId,
          Name: `local-agent-process-${operationId}`,
          Config: {
            Labels: {
              "local-agent.process-token": jobToken,
              "local-agent.process-run": run.id,
              "local-agent.process-task": task.id,
              "local-agent.process-operation": operationId,
            },
          },
          State: { Status: started ? "running" : "created", ExitCode: 0 },
        };
        if (target && exists)
          return {
            code: 0,
            stdout: JSON.stringify([anchor, job]),
            stderr: "",
            truncated: false,
          };
        return {
          code: target ? 1 : 0,
          stdout: JSON.stringify([anchor]),
          stderr: target ? `no such container ${target}` : "",
          truncated: false,
        };
      }
      if (args[0] === "create") {
        operationId = args
          .find((arg) => arg.startsWith("--name=local-agent-process-"))!
          .slice("--name=local-agent-process-".length);
        const recordPath = join(
          f.store.runDir(run.id),
          "managed-processes",
          `${operationId}.json`,
        );
        await readFile(recordPath);
        exists = true;
        jobToken = args
          .find((arg) => arg.startsWith("--label=local-agent.process-token="))!
          .split("=")
          .at(-1)!;
        return {
          code: 0,
          stdout: `${processId}\n`,
          stderr: "",
          truncated: false,
        };
      }
      if (args[0] === "start") {
        started = true;
        return { code: 0, stdout: "", stderr: "", truncated: false };
      }
      if (args[0] === "rm") {
        removed = true;
        exists = false;
        return { code: 0, stdout: "", stderr: "", truncated: false };
      }
      throw new Error(`unexpected podman call: ${args.join(" ")}`);
    };
    const executor = new TaskExecutor(
      config,
      f.store,
      runtime as never,
      new Sandbox(config.execution),
      () => {},
      runner,
    );
    const signal = controller.signal;
    const mcp = new McpTools(
      config,
      f.p,
      new Sandbox(config.execution),
      f.root,
      signal,
    );
    const beforeTool = f.store.operations(run.id);
    await assert.rejects(
      () => executor.invoke(run, task, signal, mcp),
      /synthetic provider failure after cancellation/,
    );
    operationId = f.store
      .operations(run.id)
      .find((entry) => entry.name === "process_start")!.id;
    assert.notEqual(beforeTool.length, f.store.operations(run.id).length);
    assert.equal(removed, true);
    assert.equal(
      f.store.operations(run.id).find((entry) => entry.id === operationId)
        ?.status,
      "completed",
    );
    assert.doesNotThrow(() => f.store.assertManagedProcessesStopped(run));
    await mcp.close();
  } finally {
    await f.cleanup();
  }
});

test("managed tools are restricted to ordinary coding writers", async () => {
  const run = { kind: "coding", access: "change" } as never;
  const cases = [
    [{ role: "worker", write: true }, true],
    [{ role: "reviewer", write: true }, false],
    [{ role: "worker", write: false }, false],
    [{ role: "worker", write: true, delegatedBy: "parent" }, false],
    [{ role: "worker", write: true, purpose: "synthesis" }, false],
  ] as const;
  for (const [task, expected] of cases)
    assert.equal(processToolAllowed(run, task as never), expected);

  const config = testConfig();
  config.execution.backend = "bubblewrap";
  config.execution.managedProcesses = {
    engineAnchor: {
      containerId: anchorId,
      token: "00000000-0000-4000-8000-000000000000",
    },
    maxSeconds: 60,
    maxProcesses: 1,
  };
  const f = await fixture(new ScriptedRuntime(async () => completed()), config);
  try {
    const origin = await gitWorkspace(f.root, { "README.md": "fixture\n" });
    const created = await f.harness.create({
      kind: "coding",
      objective: "non-Podman process gating",
      workspace: origin,
      access: "change",
    });
    const current = f.store.get(created.id);
    const task = {
      id: "writer",
      role: "worker" as const,
      objective: "writer",
      dependsOn: [],
      write: true,
      state: "pending" as const,
      attempts: 0,
    };
    let runnerCalls = 0;
    const tools = new TaskTools(
      config,
      f.store,
      current,
      task,
      join(f.store.runDir(current.id), "work"),
      new Sandbox(config.execution),
      undefined,
      async () => {
        runnerCalls++;
        throw new Error("unexpected engine call");
      },
    );
    assert.equal(
      tools.all().some((tool) => tool.name.startsWith("process_")),
      false,
    );
    await tools.close();
    assert.equal(runnerCalls, 0);
  } finally {
    await f.cleanup();
  }
});

test("real Podman enforces managed isolation, live workspace, logs, and deadline", async (t) => {
  const image = process.env.AGENT_TEST_PODMAN_IMAGE;
  if (!image) {
    if (process.env.AGENT_REQUIRE_PODMAN === "1")
      assert.fail(
        "Set AGENT_TEST_PODMAN_IMAGE to a preloaded digest-pinned Linux image",
      );
    t.skip("AGENT_TEST_PODMAN_IMAGE is not configured");
    return;
  }
  const root = await mkdtemp(
    join(
      process.env.AGENT_TEST_PODMAN_DIRECTORY ?? tmpdir(),
      "agent-managed-process-",
    ),
  );
  const p = paths(join(root, "state"));
  await mkdir(p.home, { recursive: true, mode: 0o700 });
  await mkdir(p.runs, { recursive: true, mode: 0o700 });
  await mkdir(p.auth, { recursive: true, mode: 0o700 });
  const config = testConfig();
  config.execution.backend = "podman";
  config.execution.image = image;
  let anchor: { containerId: string; token: string } | undefined;
  let store: Store | undefined;
  const managers: Array<{ manager: ManagedProcesses; operation: string }> = [];
  try {
    anchor = await provisionManagedProcessAnchor(config);
    config.execution.managedProcesses = {
      engineAnchor: anchor,
      maxSeconds: 20,
      maxProcesses: 1,
    };
    store = new Store(p);
    const harness = new Harness(
      config,
      p,
      store,
      new ScriptedRuntime(async () => completed()),
    );
    const origin = await gitWorkspace(root, {
      "README.md": "managed-original\n",
    });
    const created = await harness.create({
      kind: "coding",
      objective: "verify managed process",
      workspace: origin,
      access: "change",
    });
    const run = store.claim(created.id);
    const task = {
      id: "writer",
      role: "worker" as const,
      objective: "verify bounded process",
      dependsOn: [],
      write: true,
      state: "pending" as const,
      attempts: 0,
    };
    const operation = store.prepare(run, task.id, "process_start", {
      command:
        "set -e; printf tmp > /tmp/managed-write; test -s /tmp/managed-write; if touch /workspace/managed-write-denied; then exit 91; fi; if touch /etc/hostname; then exit 92; fi; while :; do cat /workspace/README.md; sleep 1; done",
    });
    const manager = new ManagedProcesses(config, store, run, task);
    managers.push({ manager, operation });
    await manager.prepare(
      task,
      operation,
      "set -e; printf tmp > /tmp/managed-write; test -s /tmp/managed-write; if touch /workspace/managed-write-denied; then exit 91; fi; if touch /etc/hostname; then exit 92; fi; while :; do cat /workspace/README.md; sleep 1; done",
    );
    store.operation(run, operation, "dispatched");
    await manager.start(
      task,
      operation,
      "set -e; printf tmp > /tmp/managed-write; test -s /tmp/managed-write; if touch /workspace/managed-write-denied; then exit 91; fi; if touch /etc/hostname; then exit 92; fi; while :; do cat /workspace/README.md; sleep 1; done",
      new AbortController().signal,
    );
    const waitForLog = async (needle: string) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const value = await manager.logs(operation);
        if (String(value.output).includes(needle)) return value;
        const current = await manager.status(operation);
        assert.notEqual(current.status, "exited");
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.fail(`managed process did not log ${needle}`);
    };
    const originalLog = await waitForLog("managed-original");
    assert.equal(originalLog.truncated, false);
    await writeFile(
      join(store.runDir(run.id), "work", "README.md"),
      "managed-updated\n",
    );
    const updatedLog = await waitForLog("managed-updated");
    assert.equal(updatedLog.truncated, false);
    await manager.stop(operation);
    assert.equal((await manager.status(operation)).status, "removed");

    const shortConfig = testConfig();
    shortConfig.execution.backend = "podman";
    shortConfig.execution.image = image;
    shortConfig.execution.managedProcesses = {
      engineAnchor: anchor,
      maxSeconds: 5,
      maxProcesses: 1,
    };
    const shortHarness = new Harness(
      shortConfig,
      p,
      store,
      new ScriptedRuntime(async () => completed()),
    );
    const shortRunCreated = await shortHarness.create({
      kind: "coding",
      objective: "verify managed deadline",
      workspace: origin,
      access: "change",
    });
    const shortRun = store.claim(shortRunCreated.id);
    const shortCommand = "printf 'ready\\n'; sleep 30";
    const shortOperation = store.prepare(shortRun, task.id, "process_start", {
      command: shortCommand,
    });
    const shortManager = new ManagedProcesses(
      shortConfig,
      store,
      shortRun,
      task,
    );
    managers.push({ manager: shortManager, operation: shortOperation });
    await shortManager.prepare(task, shortOperation, shortCommand);
    store.operation(shortRun, shortOperation, "dispatched");
    await shortManager.start(
      task,
      shortOperation,
      shortCommand,
      new AbortController().signal,
    );
    const readyDeadline = Date.now() + 10000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      const value = await shortManager.logs(shortOperation);
      if (String(value.output).includes("ready")) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    const deadline = Date.now() + 10000;
    let finalStatus: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      finalStatus = await shortManager.status(shortOperation);
      if (finalStatus.status === "exited") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(finalStatus.status, "exited");
    assert.notEqual(finalStatus.exitCode, 0);
    await shortManager.stop(shortOperation);
  } finally {
    for (const { manager, operation } of managers) {
      try {
        await manager.stop(operation);
      } catch {
        // Keep the anchor when a workload cannot be verified as removed.
      }
    }
    let safeToRemoveAnchor = true;
    for (const { manager } of managers) {
      try {
        const records = await manager.list();
        if (
          records.some(
            (record) =>
              record.phase !== "cleaned" || record.lifecycle !== "completed",
          )
        )
          safeToRemoveAnchor = false;
      } catch {
        safeToRemoveAnchor = false;
      }
    }
    if (anchor && safeToRemoveAnchor) {
      await runProcess("podman", ["rm", "--force", anchor.containerId], {
        timeoutMs: 15000,
        maxBytes: 16000,
      });
      await rm(root, { recursive: true, force: true });
    }
    store?.close();
  }
});
