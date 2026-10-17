import { randomUUID } from "node:crypto";
import { lstat, readdir, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { configHash, type Config } from "./config.js";
import { developmentDirectory, canUseProfiles } from "./development-runtime.js";
import { podmanEnvironment } from "./platform.js";
import {
  runProcess,
  type ProcessOptions,
  type ProcessResult,
} from "./process.js";
import { Store, type Operation } from "./storage.js";
import { AgentError, type Run, type Task } from "./types.js";
import {
  atomicWrite,
  canonical,
  privateDirectory,
  readBoundedFile,
  sha256,
  within,
} from "./util.js";

const recordVersion = 1;
const recordBytes = 16_000;
const guard = [
  'mem="$(cat /sys/fs/cgroup/memory.max 2>/dev/null || printf invalid)"',
  'pids="$(cat /sys/fs/cgroup/pids.max 2>/dev/null || printf invalid)"',
  'cpu="$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || printf invalid)"',
  "command=$1",
  "set -- $cpu",
  'valid() { case "$1" in ""|*[!0-9]*) return 1;; esac; test "$1" -gt 0; }',
  'if ! valid "$mem" || ! test "$mem" -le 2147483648 || ! valid "$pids" || ! test "$pids" -le 128 || ! test "$#" -eq 2 || ! valid "$1" || ! valid "$2" || ! test "$2" -ge 1000 || ! test "$2" -le 1000000 || ! test "$1" -le $((2 * $2)); then',
  '  printf "managed process cgroup limits are not enforced\\n" >&2',
  "  exit 70",
  "fi",
  'exec /bin/sh -c "$command"',
].join("\n");

interface ProcessRecord {
  version: 1;
  runId: string;
  taskId: string;
  operationId: string;
  token: string;
  name: string;
  commandSha256: string;
  engineAnchorId: string;
  engineAnchorToken: string;
  environmentBindingHash: string;
  image: string;
  phase: "intent" | "created" | "started" | "cleaned";
  containerId?: string;
  maxSeconds: number;
  maxOutputBytes: number;
}

interface InspectEntry {
  Id?: unknown;
  Names?: unknown;
  Name?: unknown;
  Labels?: unknown;
  State?: {
    Status?: unknown;
    ExitCode?: unknown;
    Error?: unknown;
  };
}

interface InspectResult {
  anchor?: InspectEntry;
  job?: InspectEntry;
}

export interface ManagedProcessRunner {
  (
    command: string,
    args: string[],
    options?: ProcessOptions,
  ): Promise<ProcessResult>;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function label(entry: InspectEntry, key: string): string | undefined {
  const labels = entry.Labels;
  return labels && typeof labels === "object" && !Array.isArray(labels)
    ? typeof (labels as Record<string, unknown>)[key] === "string"
      ? (labels as Record<string, string>)[key]
      : undefined
    : undefined;
}

function names(entry: InspectEntry): string[] {
  if (Array.isArray(entry.Names))
    return entry.Names.filter(
      (name): name is string => typeof name === "string",
    );
  return typeof entry.Name === "string" ? [entry.Name] : [];
}

function status(entry: InspectEntry): string {
  return typeof entry.State?.Status === "string"
    ? entry.State.Status
    : "unknown";
}

function generic(code: string, message: string): AgentError {
  return new AgentError(code, message);
}

export function processToolAllowed(run: Run, task: Task): boolean {
  return (
    run.kind === "coding" &&
    run.access === "change" &&
    task.role === "worker" &&
    task.write &&
    !task.delegatedBy &&
    task.purpose !== "synthesis"
  );
}

export function managedProcessEnvironmentHash(): string {
  const env = { ...podmanEnvironment(), LANG: "C", LC_ALL: "C" };
  return sha256(canonical(env));
}

export async function provisionManagedProcessAnchor(
  config: Config,
  execute: ManagedProcessRunner = runProcess,
): Promise<{ containerId: string; token: string }> {
  if (config.execution.backend !== "podman")
    throw generic(
      "PROCESS_CONFIG",
      "Managed processes require the Podman backend",
    );
  const image = config.execution.image;
  if (!image)
    throw generic("PROCESS_CONFIG", "Configure a pinned Podman image first");
  const token = randomUUID();
  const name = `local-agent-process-anchor-${randomUUID()}`;
  const env = { ...podmanEnvironment(), LANG: "C", LC_ALL: "C" };
  const info = await execute(
    "podman",
    ["info", "--format", "{{.Host.Security.Rootless}}"],
    { env, timeoutMs: 10000, maxBytes: 1000 },
  );
  if (info.code !== 0 || info.stdout.trim() !== "true")
    throw generic("PROCESS_ENGINE", "Podman must be running in rootless mode");
  process.stderr.write(
    `managed process anchor intent ${JSON.stringify({ name, token })}\n`,
  );
  const result = await execute(
    "podman",
    [
      "create",
      `--name=${name}`,
      "--pull=never",
      "--network=none",
      "--read-only",
      "--read-only-tmpfs=false",
      "--image-volume=ignore",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      "--memory=2g",
      "--cpus=2",
      "--cgroupns=private",
      "--userns=keep-id",
      "--shm-size=16m",
      "--tmpfs=/tmp:rw,nosuid,nodev,size=64m",
      `--label=local-agent.process-anchor=${token}`,
      "--entrypoint=/bin/true",
      image,
    ],
    { env, timeoutMs: 30000, maxBytes: 16000 },
  );
  if (result.code !== 0 || !isId(result.stdout.trim()))
    throw generic(
      "PROCESS_ENGINE",
      "Could not provision the managed-process anchor",
    );
  return { containerId: result.stdout.trim(), token };
}

export class ManagedProcesses {
  private readonly env: Record<string, string>;
  private readonly environmentBindingHash: string;
  private readonly execute: ManagedProcessRunner;
  private readonly directory: string;

  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly run: Run,
    readonly task?: Task,
    execute: ManagedProcessRunner = runProcess,
  ) {
    this.execute = execute;
    this.env = { ...podmanEnvironment(), LANG: "C", LC_ALL: "C" };
    this.environmentBindingHash = sha256(canonical(this.env));
    this.directory = join(store.runDir(run.id), "managed-processes");
  }

  private assertConfigured(
    task = this.task,
  ): NonNullable<Config["execution"]["managedProcesses"]> {
    if (!this.config.execution.managedProcesses)
      throw generic("PROCESS_CONFIG", "Managed processes are not configured");
    if (this.config.execution.backend !== "podman")
      throw generic(
        "PROCESS_CONFIG",
        "Managed processes require the Podman backend",
      );
    if (!this.config.execution.image)
      throw generic("PROCESS_CONFIG", "Configure a pinned Podman image first");
    if (task && !processToolAllowed(this.run, task))
      throw generic(
        "TOOL_UNAVAILABLE",
        "Managed processes are unavailable for this task",
      );
    if (configHash(this.config) !== this.run.configHash)
      throw generic(
        "PROCESS_CONFIG",
        "Configuration changed; create a new run",
      );
    return this.config.execution.managedProcesses;
  }

  private async ensureDirectory(): Promise<void> {
    await privateDirectory(this.directory);
  }

  private path(operationId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(operationId))
      throw generic("PROCESS_RECORD", "Invalid managed-process identity");
    return join(this.directory, `${operationId}.json`);
  }

  private async read(
    operationId: string,
    allowConfigurationChange = false,
  ): Promise<ProcessRecord> {
    const data = await readBoundedFile(this.path(operationId), recordBytes, {
      privateStorage: true,
    });
    let value: unknown;
    try {
      value = JSON.parse(data.toString("utf8"));
    } catch {
      throw generic("PROCESS_RECORD", "Managed-process identity is invalid");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw generic("PROCESS_RECORD", "Managed-process identity is invalid");
    const record = value as Partial<ProcessRecord>;
    const keys = new Set([
      "version",
      "runId",
      "taskId",
      "operationId",
      "token",
      "name",
      "commandSha256",
      "engineAnchorId",
      "engineAnchorToken",
      "environmentBindingHash",
      "image",
      "phase",
      "containerId",
      "maxSeconds",
      "maxOutputBytes",
    ]);
    if (
      Object.keys(record).some((key) => !keys.has(key)) ||
      record.version !== recordVersion ||
      record.runId !== this.run.id ||
      record.operationId !== operationId ||
      typeof record.taskId !== "string" ||
      !isUuid(record.token) ||
      typeof record.name !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.commandSha256 ?? "") ||
      !/^[a-f0-9]{64}$/.test(record.engineAnchorId ?? "") ||
      !isUuid(record.engineAnchorToken) ||
      !/^[a-f0-9]{64}$/.test(record.environmentBindingHash ?? "") ||
      typeof record.image !== "string" ||
      !["intent", "created", "started", "cleaned"].includes(
        record.phase ?? "",
      ) ||
      !Number.isInteger(record.maxSeconds) ||
      (record.maxSeconds ?? 0) < 1 ||
      (record.maxSeconds ?? 0) > 3600 ||
      !Number.isInteger(record.maxOutputBytes) ||
      (record.maxOutputBytes ?? 0) < 1024 ||
      (record.maxOutputBytes ?? 0) > 1_000_000 ||
      (record.containerId !== undefined && !isId(record.containerId))
    )
      throw generic("PROCESS_RECORD", "Managed-process identity is invalid");
    const expectedName = `local-agent-process-${operationId}`;
    if (
      record.name !== expectedName ||
      (!allowConfigurationChange &&
        record.engineAnchorId !==
          this.config.execution.managedProcesses?.engineAnchor.containerId)
    )
      throw generic(
        "PROCESS_RECORD",
        "Managed-process identity does not match configuration",
      );
    return record as ProcessRecord;
  }

  private async write(record: ProcessRecord): Promise<void> {
    await this.ensureDirectory();
    await atomicWrite(this.path(record.operationId), JSON.stringify(record));
  }

  private async inspect(
    record: ProcessRecord | undefined,
    target?: string,
  ): Promise<InspectResult> {
    const anchorId =
      record?.engineAnchorId ??
      this.config.execution.managedProcesses!.engineAnchor.containerId;
    const args = ["inspect", "--type=container", anchorId];
    if (target) args.push(target);
    const result = await this.execute("podman", args, {
      env: this.env,
      timeoutMs: 10000,
      maxBytes: 256000,
    });
    let parsed: InspectEntry[] = [];
    try {
      const value = JSON.parse(result.stdout);
      parsed = Array.isArray(value) ? value : [];
    } catch {
      parsed = [];
    }
    const anchor = parsed.find(
      (entry) => isId(entry.Id) && entry.Id === anchorId,
    );
    const job = parsed.find(
      (entry) =>
        !!target &&
        !!record &&
        (names(entry).includes(record.name) ||
          (record.containerId && entry.Id === record.containerId)),
    );
    if (!anchor) {
      if (job && record) return { job };
      throw generic(
        "PROCESS_ENGINE",
        "Managed-process engine anchor is not owned",
      );
    }
    if (
      label(anchor, "local-agent.process-anchor") !==
      (record?.engineAnchorToken ??
        this.config.execution.managedProcesses!.engineAnchor.token)
    )
      throw generic(
        "PROCESS_ENGINE",
        "Managed-process engine anchor is not owned",
      );
    if (!target) return { anchor };
    if (job) return { anchor, job };
    const missing = new RegExp(
      `(?:no such|not found|cannot find)[^\\n]*${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      "i",
    );
    if (result.code === 0 || !missing.test(result.stderr))
      throw generic(
        "PROCESS_ENGINE",
        "Managed-process inspection was inconclusive",
      );
    return { anchor };
  }

  private async rootAndRuntime(task: Task): Promise<{
    root: string;
    runtime?: string;
  }> {
    const root = await realpath(this.store.runDir(this.run.id) + "/work");
    const rootStat = await lstat(root);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      rootStat.mode & 0o077
    )
      throw generic("PROCESS_PATH", "Managed-process workspace is not private");
    let runtime: string | undefined;
    if (
      Object.keys(this.config.execution.profiles ?? {}).length &&
      canUseProfiles(this.run, task)
    )
      runtime = await developmentDirectory(
        this.store.runDir(this.run.id),
        this.run,
        task,
      );
    if (runtime) {
      const runtimeStat = await lstat(runtime);
      const resolved = await realpath(runtime);
      if (
        !runtimeStat.isDirectory() ||
        runtimeStat.isSymbolicLink() ||
        runtimeStat.mode & 0o077 ||
        within(root, resolved) ||
        within(resolved, root) ||
        resolved.includes(":")
      )
        throw generic("PROCESS_PATH", "Managed-process runtime is not private");
      runtime = resolved;
    }
    if (root.includes(":"))
      throw generic(
        "PROCESS_PATH",
        "Managed-process workspace path is invalid",
      );
    return { root, runtime };
  }

  private operations(): Operation[] {
    return this.store.operations(this.run.id);
  }

  async prepare(
    task: Task,
    operationId: string,
    command: string,
  ): Promise<void> {
    const limits = this.assertConfigured(task);
    const operation = this.operations().find(
      (entry) => entry.id === operationId,
    );
    if (
      !operation ||
      operation.name !== "process_start" ||
      operation.status !== "prepared"
    )
      throw generic(
        "PROCESS_OPERATION",
        "Managed-process operation is invalid",
      );
    if (
      this.operations().some(
        (entry) => entry.name === "process_start" && entry.status === "unknown",
      )
    )
      throw generic(
        "PROCESS_CLEANUP_REQUIRED",
        "Stop unresolved managed processes before starting another",
      );
    const active = this.operations().filter(
      (entry) =>
        entry.name === "process_start" &&
        ["prepared", "dispatched", "unknown"].includes(entry.status),
    ).length;
    if (active > limits.maxProcesses)
      throw generic(
        "PROCESS_LIMIT",
        "The managed-process limit is already reached",
      );
    const info = await this.execute(
      "podman",
      ["info", "--format", "{{.Host.Security.Rootless}}"],
      { env: this.env, timeoutMs: 10000, maxBytes: 1000 },
    );
    if (info.code !== 0 || info.stdout.trim() !== "true")
      throw generic(
        "PROCESS_ENGINE",
        "Podman must be running in rootless mode",
      );
    await this.inspect(undefined);
    await this.ensureDirectory();
    const record: ProcessRecord = {
      version: 1,
      runId: this.run.id,
      taskId: task.id,
      operationId,
      token: randomUUID(),
      name: `local-agent-process-${operationId}`,
      commandSha256: sha256(command),
      engineAnchorId: limits.engineAnchor.containerId,
      engineAnchorToken: limits.engineAnchor.token,
      environmentBindingHash: this.environmentBindingHash,
      image: this.config.execution.image!,
      phase: "intent",
      maxSeconds: limits.maxSeconds,
      maxOutputBytes: this.config.execution.maxOutputBytes,
    };
    await this.write(record);
  }

  async abandonPrepared(operationId: string): Promise<void> {
    try {
      const record = await this.read(operationId);
      if (record.phase === "intent")
        await rm(this.path(operationId), { force: true });
    } catch {
      // A failed pre-dispatch preparation is reported by the operation itself.
    }
  }

  async start(
    task: Task,
    operationId: string,
    command: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.assertConfigured(task);
    const operation = this.operations().find(
      (entry) => entry.id === operationId,
    );
    if (
      !operation ||
      operation.name !== "process_start" ||
      operation.task_id !== task.id ||
      operation.args_hash !== sha256(canonical({ command })) ||
      operation.status !== "dispatched"
    )
      throw generic(
        "PROCESS_OPERATION",
        "Managed-process operation is not dispatched",
      );
    const record = await this.read(operationId);
    if (
      record.taskId !== task.id ||
      record.commandSha256 !== sha256(command) ||
      record.environmentBindingHash !== this.environmentBindingHash ||
      record.image !== this.config.execution.image ||
      record.phase !== "intent"
    )
      throw generic(
        "PROCESS_RECORD",
        "Managed-process identity binding failed",
      );
    const { root, runtime } = await this.rootAndRuntime(task);
    await this.inspect(record);
    signal.throwIfAborted();
    const args = [
      "create",
      `--name=${record.name}`,
      "--pull=never",
      "--network=none",
      "--read-only",
      "--read-only-tmpfs=false",
      "--image-volume=ignore",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=128",
      "--memory=2g",
      "--cpus=2",
      "--cgroupns=private",
      "--userns=keep-id",
      "--shm-size=16m",
      "--tmpfs=/tmp:rw,nosuid,nodev,size=64m",
      `--label=local-agent.process-token=${record.token}`,
      `--label=local-agent.process-run=${record.runId}`,
      `--label=local-agent.process-task=${record.taskId}`,
      `--label=local-agent.process-operation=${record.operationId}`,
      `--log-driver=k8s-file`,
      `--log-opt=max-size=${record.maxOutputBytes}`,
      `--timeout=${record.maxSeconds}`,
      `--volume=${root}:/workspace:ro`,
      ...(runtime ? [`--volume=${runtime}:/runtime:ro`] : []),
      "--workdir=/workspace",
      "--env=HOME=/tmp",
      "--env=TMPDIR=/tmp",
      "--entrypoint=/bin/sh",
      record.image,
      "-c",
      guard,
      "local-agent-managed-process",
      command,
    ];
    const created = await this.execute("podman", args, {
      env: this.env,
      signal,
      timeoutMs: 30000,
      maxBytes: 16000,
    });
    if (created.code !== 0 || !isId(created.stdout.trim()))
      throw generic("PROCESS_ENGINE", "Managed process creation failed");
    const containerId = created.stdout.trim();
    const createdRecord = { ...record, phase: "created" as const, containerId };
    await this.write(createdRecord);
    const proof = await this.inspect(createdRecord, record.name);
    if (!proof.job || proof.job.Id !== containerId)
      throw generic(
        "PROCESS_ENGINE",
        "Managed process identity could not be verified",
      );
    this.assertJob(proof.job, createdRecord);
    signal.throwIfAborted();
    const started = await this.execute("podman", ["start", containerId], {
      env: this.env,
      signal,
      timeoutMs: 15000,
      maxBytes: 16000,
    });
    if (started.code !== 0)
      throw generic("PROCESS_ENGINE", "Managed process start failed");
    await this.write({ ...createdRecord, phase: "started" });
    return { processId: operationId, containerId, status: "running" };
  }

  private assertJob(entry: InspectEntry, record: ProcessRecord): void {
    if (
      (record.containerId !== undefined && entry.Id !== record.containerId) ||
      !isId(entry.Id) ||
      !names(entry).includes(record.name) ||
      label(entry, "local-agent.process-token") !== record.token ||
      label(entry, "local-agent.process-run") !== record.runId ||
      label(entry, "local-agent.process-task") !== record.taskId ||
      label(entry, "local-agent.process-operation") !== record.operationId
    )
      throw generic(
        "PROCESS_OWNERSHIP",
        "Managed process identity is not owned",
      );
  }

  private async verified(
    operationId: string,
  ): Promise<{ record: ProcessRecord; inspection: InspectResult }> {
    const record = await this.read(operationId, true);
    const operation = this.operations().find(
      (entry) => entry.id === operationId,
    );
    if (
      !operation ||
      operation.name !== "process_start" ||
      operation.task_id !== record.taskId
    )
      throw generic(
        "PROCESS_OWNERSHIP",
        "Managed process operation is not owned",
      );
    if (record.environmentBindingHash !== this.environmentBindingHash)
      throw generic(
        "PROCESS_ENGINE",
        "Managed-process engine environment changed",
      );
    if (this.task && record.taskId !== this.task.id)
      throw generic(
        "PROCESS_OWNERSHIP",
        "Managed process belongs to another task",
      );
    const target = record.containerId ?? record.name;
    const inspection = await this.inspect(record, target);
    if (inspection.job) {
      this.assertJob(inspection.job, record);
      if (!record.containerId) {
        record.containerId = inspection.job.Id as string;
        if (record.phase === "intent") record.phase = "created";
        await this.write(record);
      }
    }
    return { record, inspection };
  }

  async status(operationId: string): Promise<Record<string, unknown>> {
    const { record, inspection } = await this.verified(operationId);
    if (!inspection.job)
      return {
        processId: operationId,
        status: record.phase === "cleaned" ? "removed" : "cleanup-unresolved",
      };
    return {
      processId: operationId,
      status: status(inspection.job),
      containerId: record.containerId,
      exitCode: inspection.job.State?.ExitCode,
    };
  }

  async logs(operationId: string): Promise<Record<string, unknown>> {
    const { record, inspection } = await this.verified(operationId);
    if (!inspection.job)
      throw generic(
        "PROCESS_NOT_FOUND",
        "Managed process is unavailable; stop it to complete cleanup",
      );
    const id = record.containerId!;
    const result = await this.execute("podman", ["logs", "--tail=200", id], {
      env: this.env,
      timeoutMs: 10000,
      maxBytes: record.maxOutputBytes,
    });
    if (result.code !== 0)
      throw generic("PROCESS_ENGINE", "Managed process logs are unavailable");
    const stdout = result.stdout,
      stderr = result.stderr;
    let output = stdout + (stderr ? `${stdout ? "\n" : ""}${stderr}` : "");
    let truncated = result.truncated;
    const bytes = Buffer.from(output);
    if (bytes.length > record.maxOutputBytes) {
      output = bytes.subarray(0, record.maxOutputBytes).toString("utf8");
      truncated = true;
    }
    return { processId: operationId, output, truncated };
  }

  async stop(operationId: string): Promise<Record<string, unknown>> {
    let verified: { record: ProcessRecord; inspection: InspectResult };
    try {
      verified = await this.verified(operationId);
    } catch (error) {
      this.markUnknown(operationId, "Managed process cleanup is unresolved");
      throw error;
    }
    const { record, inspection } = verified;
    if (inspection.job) {
      const result = await this.execute(
        "podman",
        ["rm", "--force", record.containerId!],
        {
          env: this.env,
          timeoutMs: 15000,
          maxBytes: 16000,
        },
      );
      if (result.code !== 0) {
        this.markUnknown(
          operationId,
          "Managed process removal was not confirmed",
        );
        throw generic(
          "PROCESS_CLEANUP",
          "Managed process removal was not confirmed",
        );
      }
      if (inspection.anchor) {
        const after = await this.inspect(record, record.containerId!);
        if (after.job) {
          this.markUnknown(
            operationId,
            "Managed process remains after removal",
          );
          throw generic(
            "PROCESS_CLEANUP",
            "Managed process removal was not confirmed",
          );
        }
      }
    }
    await this.write({ ...record, phase: "cleaned" });
    this.complete(
      operationId,
      "Managed process removed and cleanup was durably recorded",
    );
    return { processId: operationId, status: "removed" };
  }

  private complete(operationId: string, result: string): void {
    const operation = this.operations().find(
      (entry) => entry.id === operationId,
    );
    if (!operation || operation.name !== "process_start") return;
    if (operation.status === "completed") return;
    if (!["dispatched", "unknown"].includes(operation.status))
      throw generic(
        "PROCESS_OPERATION",
        "Managed-process operation is not unresolved",
      );
    this.store.managedProcessState(this.run, operationId, "completed", result);
  }

  private markUnknown(operationId: string, result: string): void {
    const operation = this.operations().find(
      (entry) => entry.id === operationId,
    );
    if (!operation || operation.name !== "process_start") return;
    if (["dispatched", "unknown"].includes(operation.status)) {
      try {
        this.store.managedProcessState(
          this.run,
          operationId,
          "unknown",
          result,
        );
      } catch {
        // The original cleanup error remains the visible failure.
      }
    }
  }

  async closeTask(taskId: string): Promise<void> {
    this.assertConfigured();
    const operationIds = this.operations()
      .filter(
        (operation) =>
          operation.name === "process_start" &&
          operation.task_id === taskId &&
          ["dispatched", "unknown"].includes(operation.status),
      )
      .map((operation) => operation.id);
    if (!operationIds.length) return;
    await this.ensureDirectory();
    const failures: unknown[] = [];
    for (const operationId of operationIds) {
      try {
        await this.stop(operationId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw generic(
        "PROCESS_CLEANUP",
        `Managed-process cleanup failed for ${failures.length} process(es)`,
      );
  }

  async list(): Promise<Array<Record<string, unknown>>> {
    try {
      const stat = await lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw generic("PROCESS_RECORD", "Managed-process directory is unsafe");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records: Array<Record<string, unknown>> = [];
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const operationId = name.slice(0, -5);
      try {
        const record = await this.read(operationId, true);
        const operation = this.operations().find(
          (entry) => entry.id === operationId,
        );
        records.push({
          processId: operationId,
          taskId: record.taskId,
          phase: record.phase,
          lifecycle: operation?.status ?? "unknown",
          containerId: record.containerId,
        });
      } catch {
        records.push({ processId: operationId, status: "cleanup-unresolved" });
      }
    }
    return records;
  }
}
