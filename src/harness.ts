import { realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  configHash,
  ensureOutsideWorkspace,
  type Config,
  type Paths,
} from "./config.js";
import { McpTools } from "./mcp.js";
import { Planner } from "./planner.js";
import { Router } from "./routing.js";
import { runFailureState } from "./run-state.js";
import { Sandbox } from "./sandbox.js";
import { Store } from "./storage.js";
import { TaskExecutor } from "./task-executor.js";
import {
  AgentError,
  type DataClass,
  type ImageReference,
  type Run,
  type Runtime,
  type WorkKind,
} from "./types.js";
import {
  loadStoredImage,
  maxConversationImageBytes,
  maxConversationImages,
} from "./images.js";
import {
  atomicWrite,
  canonical,
  errorMessage,
  id,
  privateDirectory,
  readText,
  sha256,
} from "./util.js";
import { Evaluator } from "./validation.js";
import {
  inventory,
  continueWorkspace,
  readSnapshot,
  secretPath,
  snapshotWorkspace,
  verifyOriginal,
} from "./workspace.js";
export interface NewRun {
  extraPaths?: string[];
  parentRunId?: string;
  context?: string;
  previousSessions?: Run["previousSessions"];
  objective: string;
  kind: WorkKind;
  mode?: Run["mode"];
  dataClass?: Run["dataClass"];
  localOnly?: boolean;
  workspace?: string;
  includeUntracked?: boolean;
  inputs?: string[];
  images?: ImageReference[];
  checks?: string[];
  mustKeep?: string[];
  model?: string;
  reviewer?: string;
}
export class Harness {
  readonly sandbox: Sandbox;
  readonly evaluator: Evaluator;
  readonly router: Router;
  readonly executor: TaskExecutor;
  readonly planner: Planner;
  constructor(
    readonly config: Config,
    readonly paths: Paths,
    readonly store: Store,
    readonly runtime: Runtime,
    readonly notify: (
      type: string,
      detail: Record<string, unknown>,
    ) => void = () => {},
  ) {
    this.sandbox = new Sandbox(config.execution);
    this.evaluator = new Evaluator(config, store, this.sandbox, notify);
    this.router = new Router(config, store);
    this.executor = new TaskExecutor(
      config,
      store,
      runtime,
      this.sandbox,
      notify,
    );
    this.planner = new Planner(config, store, this.router, this.executor);
  }
  async create(options: NewRun): Promise<Run> {
    if (!options.objective.trim())
      throw new AgentError("INPUT", "An objective is required");
    if (Buffer.byteLength(options.objective) > this.config.limits.maxInputBytes)
      throw new AgentError("INPUT_SIZE", "Objective exceeds the input limit");
    const workspace = options.workspace
      ? await realpath(resolve(options.workspace))
      : undefined;
    if (options.kind === "coding" && !workspace)
      throw new AgentError("WORKSPACE", "Coding requires --workspace");
    if (workspace) await ensureOutsideWorkspace(this.paths, workspace);
    const images = [
      ...new Map(
        (options.images ?? []).map((reference) => [reference.id, reference]),
      ).values(),
    ];
    const dataLevels: DataClass[] = ["public", "private", "restricted"];
    const imageDataClass = images.reduce<DataClass>(
      (current, ref) =>
        dataLevels.indexOf(ref.dataClass) > dataLevels.indexOf(current)
          ? ref.dataClass
          : current,
      options.dataClass ?? this.config.defaults.dataClass,
    );
    const imageLocalOnly =
      (options.localOnly ?? false) || images.some((ref) => ref.localOnly);
    if (
      images.length > maxConversationImages ||
      images.reduce((sum, ref) => sum + ref.bytes, 0) >
        maxConversationImageBytes
    )
      throw new AgentError(
        "IMAGE_LIMIT",
        "Image count or cumulative bytes exceed the conversation limit",
      );
    for (const ref of images) await loadStoredImage(this.paths, ref);
    for (const check of options.checks ?? [])
      if (!this.config.checks[check])
        throw new AgentError(
          "CHECK_CONFIG",
          `Unknown required check: ${check}`,
        );
    const run: Run = {
      parentRunId: options.parentRunId,
      context: options.context,
      previousSessions: options.previousSessions,
      prepared: false,
      id: id(),
      objective: options.objective,
      kind: options.kind,
      mode: options.mode ?? this.config.defaults.mode,
      dataClass: imageDataClass,
      localOnly: imageLocalOnly,
      workspace,
      model: options.model,
      reviewer: options.reviewer,
      state: "created",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      elapsedMs: 0,
      generation: 0,
      configHash: configHash(this.config),
      tasks: [],
      inputs: [],
      images: images.length ? structuredClone(images) : undefined,
      checks: options.checks ?? [],
      mustKeep: options.mustKeep ?? [],
      planAttempts: 0,
      repairAttempts: 0,
    };
    await privateDirectory(this.paths.runs);
    this.store.create(run);
    const owned = this.store.claim(run.id),
      directory = this.store.runDir(run.id);
    const heartbeat = setInterval(() => {
      try {
        this.store.heartbeat(owned);
      } catch {
        /* Final save also verifies ownership. */
      }
    }, 1000);
    heartbeat.unref();
    try {
      await privateDirectory(directory);
      if (options.parentRunId) {
        this.store.assertIdle(options.parentRunId);
        const parent = this.store.get(options.parentRunId);
        if (
          ["public", "private", "restricted"].indexOf(run.dataClass) <
            ["public", "private", "restricted"].indexOf(parent.dataClass) ||
          (parent.localOnly && !run.localOnly)
        )
          throw new AgentError(
            "DISCLOSURE_DENIED",
            "A continued working copy cannot widen disclosure permissions",
          );
        if (
          !parent.prepared ||
          parent.workspace !== workspace ||
          (parent.kind !== run.kind &&
            !(
              ["writing", "research"].includes(parent.kind) &&
              ["writing", "research"].includes(run.kind)
            ))
        )
          throw new AgentError(
            "CONTINUATION",
            "Previous working copy does not match this request",
          );
        if (
          this.store
            .operations(parent.id)
            .some(
              (o) =>
                o.status === "unknown" ||
                o.status === "dispatched" ||
                (o.name === "apply" && o.status === "completed"),
            )
        )
          throw new AgentError(
            "UNKNOWN_OPERATION",
            "Reconcile pending operations or refresh the applied baseline before continuing",
          );
        await continueWorkspace(
          this.store.runDir(parent.id),
          directory,
          this.config,
        );
        // Source IDs remain stable so existing citations continue to resolve.
        this.store.inheritSources(parent.id, owned.id);
      } else
        await snapshotWorkspace(
          directory,
          workspace,
          options.includeUntracked ?? false,
          this.config,
          options.extraPaths,
        );
      if (workspace) await verifyOriginal(await readSnapshot(directory));
      for (const [index, path] of (options.inputs ?? []).entries()) {
        if (secretPath(basename(path)))
          throw new AgentError(
            "INPUT",
            "Credential-like input filenames are excluded",
          );
        const text = await readText(
          resolve(path),
          this.config.limits.maxFileBytes,
        );
        const name = `inputs/${index + 1}-${basename(path)}`;
        // A coding reference must not introduce an inputs/ file into the applied patch.
        if (run.kind !== "coding")
          await atomicWrite(join(directory, "work", name), text);
        const source = await this.store.artifact(owned, name, "source", text, {
          input: true,
          sourcePath: resolve(path),
          retrievedAt: new Date().toISOString(),
        });
        owned.inputs.push(source.id);
      }
      await atomicWrite(
        join(directory, "policy.json"),
        JSON.stringify(this.config, null, 2),
      );
      owned.prepared = true;
      this.store.save(owned);
      return owned;
    } catch (error) {
      this.store.transition(owned, "failed", errorMessage(error));
      throw error;
    } finally {
      clearInterval(heartbeat);
      this.store.release(owned);
    }
  }
  async execute(
    runId: string,
    signal?: AbortSignal,
    additionalInput?: string,
    takeInstructions: () => string[] = () => [],
    acknowledgeInstructions: () => void = () => {},
  ): Promise<Run> {
    let run = this.store.get(runId);
    if (run.configHash !== configHash(this.config))
      throw new AgentError(
        "POLICY_CHANGED",
        "Configuration changed; create a new run to use the new policy",
      );
    run = this.store.claim(runId);
    const controller = new AbortController(),
      started = Date.now(),
      elapsed = run.elapsedMs;
    const propagate = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", propagate, { once: true });
    if (signal?.aborted) propagate();
    let timedOut = false;
    const tick = setInterval(() => {
      try {
        run.elapsedMs = elapsed + Date.now() - started;
        if (this.store.heartbeat(run) || signal?.aborted) controller.abort();
        if (run.elapsedMs >= this.config.limits.maxSeconds * 1000) {
          timedOut = true;
          controller.abort();
        }
      } catch {
        controller.abort();
      }
    }, 1000);
    tick.unref();
    const directory = this.store.runDir(run.id),
      work = join(directory, "work");
    const acceptInstructions = (): boolean => {
      const instructions = takeInstructions();
      if (!instructions.length) return false;
      const objective =
        run.objective +
        "\n\nAdditional user instructions:\n" +
        instructions.join("\n\n");
      if (Buffer.byteLength(objective) > this.config.limits.maxInputBytes)
        throw new AgentError(
          "INPUT_SIZE",
          "Additional instructions exceed the input limit",
        );
      run.objective = objective;
      for (const task of run.tasks) {
        task.state = "pending";
        task.result = undefined;
      }
      this.store.save(
        run,
        "instructions_accepted",
        { count: instructions.length },
        acknowledgeInstructions,
      );
      this.notify("instructions_accepted", {
        runId: run.id,
        count: instructions.length,
      });
      return true;
    };
    const mcp = new McpTools(
      this.config,
      this.paths,
      this.sandbox,
      work,
      controller.signal,
    );
    const closeResources = async () => {
      const results = await Promise.allSettled([
        mcp.close(),
        this.runtime.close(),
      ]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    };
    try {
      if (this.store.cancelRequested(run.id)) controller.abort();
      controller.signal.throwIfAborted();
      if (!run.prepared)
        throw new AgentError(
          "PREPARATION_INCOMPLETE",
          "Input snapshot was interrupted; create a new run from the original request",
        );
      for (const ref of run.images ?? [])
        await loadStoredImage(this.paths, ref);
      if (run.elapsedMs >= this.config.limits.maxSeconds * 1000)
        throw new AgentError("BUDGET", "Run time budget exhausted");
      const unknown = this.store
        .operations(run.id)
        .filter((o) => o.status === "unknown");
      if (unknown.length)
        throw new AgentError(
          "UNKNOWN_OPERATION",
          `${unknown.length} operations need reconciliation; use agent reconcile before resuming`,
        );
      if (additionalInput) {
        if (
          run.state !== "waiting_input" &&
          run.state !== "waiting_quota" &&
          run.state !== "created"
        )
          throw new AgentError(
            "INPUT",
            "Additional input is accepted only while waiting or before execution",
          );
        if (
          Buffer.byteLength(run.objective + additionalInput) >
          this.config.limits.maxInputBytes
        )
          throw new AgentError(
            "INPUT_SIZE",
            "Additional input exceeds the limit",
          );
        run.objective += "\n\nAdditional user instruction:\n" + additionalInput;
        this.store.event(run.id, "user_input", { text: additionalInput });
        // New requirements invalidate every prior result and independent review.
        for (const task of run.tasks) {
          task.state = "pending";
          task.result = undefined;
        }
      }
      if (run.kind === "coding" && !run.checks.length)
        throw new AgentError(
          "CHECK_CONFIG",
          "Coding requires at least one --check from the trusted configuration",
        );
      if (run.kind === "coding" || run.checks.length) {
        const probe = await this.sandbox.probe(work);
        if (!probe.ok) throw new AgentError("SANDBOX", probe.detail);
      }
      if (!run.tasks.length)
        await this.planner.plan(run, controller.signal, mcp);
      this.store.transition(run, "running");
      while (true) {
        try {
          await this.executor.schedule(
            run,
            controller.signal,
            mcp,
            acceptInstructions,
          );
        } catch (error) {
          if (
            error instanceof AgentError &&
            ["TASK_FAILED", "INVALID_RESULT", "ARTIFACT_MISSING"].includes(
              error.code,
            )
          ) {
            await this.repair(run, error.message, work);
            continue;
          }
          throw error;
        }
        controller.signal.throwIfAborted();
        if (acceptInstructions()) continue;
        if (this.store.operations(run.id).some((o) => o.status === "unknown"))
          throw new AgentError(
            "UNKNOWN_OPERATION",
            "An operation needs reconciliation before validation",
          );
        this.store.transition(run, "validating");
        this.notify("validation_started", {
          runId: run.id,
          generation: run.generation,
        });
        const checks = await this.evaluator.validate(run, controller.signal);
        this.notify("validation", { runId: run.id, checks });
        if (acceptInstructions()) {
          this.store.transition(run, "running");
          continue;
        }
        if (checks.every((check) => check.passed)) {
          await this.evaluator.verifyPublished(run);
          await this.store.artifact(
            run,
            "result.json",
            "report",
            JSON.stringify(
              {
                runId: run.id,
                objective: run.objective,
                kind: run.kind,
                tasks: run.tasks.map((t) => ({
                  id: t.id,
                  model: t.model,
                  result: t.result,
                })),
                checks,
                usage: this.store.usage(run.id),
                limitations:
                  run.kind === "research"
                    ? [
                        "Citation existence and line ranges are verified; semantic support still requires human judgment.",
                      ]
                    : [],
              },
              null,
              2,
            ),
          );
          await closeResources();
          if (
            elapsed + Date.now() - started >=
            this.config.limits.maxSeconds * 1000
          ) {
            timedOut = true;
            controller.abort();
          }
          if (this.store.cancelRequested(run.id)) controller.abort();
          controller.signal.throwIfAborted();
          this.store.transition(run, "succeeded");
          this.notify("succeeded", { runId: run.id });
          return run;
        }
        const failed = checks.filter((c) => !c.passed);
        await this.repair(
          run,
          failed.map((c) => `${c.id}: ${c.detail}`).join("; "),
          work,
        );
      }
    } catch (error) {
      try {
        await closeResources();
      } catch (cleanupError) {
        error = new AgentError(
          "SANDBOX_CLEANUP",
          `${errorMessage(error)}; cleanup: ${errorMessage(cleanupError)}`,
        );
      }
      const state = runFailureState(error, {
        timedOut,
        cancelled: controller.signal.aborted,
        uncertain: this.store
          .operations(run.id)
          .some((operation) => operation.status === "unknown"),
      });
      this.store.transition(
        run,
        state,
        timedOut ? "Run time budget exhausted" : errorMessage(error),
      );
      this.notify(state, { runId: run.id, reason: run.reason });
      return run;
    } finally {
      clearInterval(tick);
      signal?.removeEventListener("abort", propagate);
      run.elapsedMs = elapsed + Date.now() - started;
      try {
        this.store.save(run, "run_released");
      } finally {
        this.store.release(run);
      }
    }
  }
  private async repair(
    run: Run,
    feedback: string,
    work: string,
  ): Promise<void> {
    const fingerprint = sha256(
      canonical({
        files: await inventory(work, this.config.limits.maxWorkspaceBytes),
        feedback,
      }),
    );
    if (
      run.repairAttempts >= this.config.limits.maxRepairs ||
      fingerprint === run.lastFailureFingerprint
    )
      throw new AgentError("VALIDATION_FAILED", feedback);
    const failedWriter = run.tasks.find((t) => t.write && t.state === "failed");
    const writer =
      failedWriter ?? [...run.tasks].reverse().find((t) => t.write);
    if (!writer)
      throw new AgentError(
        "VALIDATION_FAILED",
        "No writer task can repair this result",
      );
    run.repairAttempts++;
    run.lastFailureFingerprint = fingerprint;
    this.store.transition(run, "repairing");
    writer.objective +=
      "\nRepair these validation/review failures. Inspect the current copy before editing:\n" +
      feedback;
    const invalidated = new Set([writer.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of run.tasks)
        if (
          !invalidated.has(task.id) &&
          (task.role === "reviewer" ||
            task.dependsOn.some((dep) => invalidated.has(dep)))
        ) {
          invalidated.add(task.id);
          changed = true;
        }
    }
    for (const task of run.tasks)
      if (invalidated.has(task.id)) {
        task.state = "pending";
        task.result = undefined;
      }
    this.store.save(run, "repair_requested", {
      taskId: writer.id,
      feedback,
      attempt: run.repairAttempts,
    });
    this.store.transition(run, "running");
  }
}
