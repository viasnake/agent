import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  configHash,
  ensureOutsideWorkspace,
  type Config,
  type Paths,
} from "./config.js";
import { McpTools } from "./mcp.js";
import type { ToolApprovalHandler } from "./tool-approval.js";
import { Planner } from "./planner.js";
import { Router } from "./routing.js";
import { runFailureState } from "./run-state.js";
import { Sandbox } from "./sandbox.js";
import { Store } from "./storage.js";
import { lineagePolicy, safetyContext } from "./branching.js";
import { normalizeConversationContext } from "./context.js";
import { assertContextReady } from "./context-review.js";
import { TaskExecutor } from "./task-executor.js";
import { isCollaborative } from "./collaboration.js";
import { recordModelChangeResolution as recordTaskModelChangeResolution } from "./model-change.js";
import {
  AgentError,
  type DataClass,
  type ImageReference,
  type ConversationContext,
  type RequestAccess,
  type Run,
  type Runtime,
  type WorkKind,
  type PreparedInput,
  type Task,
} from "./types.js";
import {
  loadStoredImage,
  maxConversationImageBytes,
  maxConversationImages,
  mergeImageReferences,
} from "./images.js";
import {
  atomicWrite,
  canonical,
  errorMessage,
  id,
  privateDirectory,
  safePath,
  sha256,
} from "./util.js";
import { Evaluator } from "./validation.js";
import {
  inventory,
  continueWorkspace,
  readSnapshot,
  sanitizeWorkCopy,
  secretPath,
  snapshotWorkspace,
  verifyOriginal,
} from "./workspace.js";
import {
  loadPreparedInput,
  maxDocumentBytes,
  maxPreparedDocuments,
  maxPreparedInputBytes,
  maxSkillBytes,
  parseDocumentToken,
  prepareDocument,
} from "./documents.js";
import {
  selectGitInput,
  storeGitInput,
  type GitInputSelection,
} from "./git-input.js";
export interface NewRun {
  extraPaths?: string[];
  parentRunId?: string;
  snapshotRunId?: string;
  sourceRunIds?: string[];
  context?: string;
  contextState?: ConversationContext;
  conversationId?: string;
  constraints?: string[];
  access?: RequestAccess;
  compactions?: Run["compactions"];
  previousSessions?: Run["previousSessions"];
  objective: string;
  kind: WorkKind;
  mode?: Run["mode"];
  dataClass?: Run["dataClass"];
  localOnly?: boolean;
  workspace?: string;
  includeUntracked?: boolean;
  inputs?: string[];
  preparedInputs?: PreparedInput[];
  images?: ImageReference[];
  checks?: string[];
  mustKeep?: string[];
  model?: string;
  reviewer?: string;
  redactedImageHashes?: string[];
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
    readonly approveTool?: ToolApprovalHandler,
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
    const floor = options.conversationId
      ? lineagePolicy(this.store, options.conversationId)
      : undefined;
    if (floor) {
      const levels: DataClass[] = ["public", "private", "restricted"];
      if (
        levels.indexOf(options.dataClass ?? this.config.defaults.dataClass) <
          levels.indexOf(floor.dataClass) ||
        (floor.localOnly && !options.localOnly)
      )
        throw new AgentError(
          "DISCLOSURE_DENIED",
          "Branch input cannot lower its inherited disclosure policy",
        );
      const context = normalizeConversationContext(options.contextState);
      const safety = safetyContext(context, floor.excluded);
      options = {
        ...options,
        contextState: {
          ...context,
          excludedSourceIds: safety.excludedSourceIds,
          excludedSourceHashes: safety.excludedSourceHashes,
          excludedSourceUrls: safety.excludedSourceUrls,
          redactedImageIds: safety.redactedImageIds,
        },
      };
    }
    if (!options.objective.trim())
      throw new AgentError("INPUT", "An objective is required");
    if (Buffer.byteLength(options.objective) > this.config.limits.maxInputBytes)
      throw new AgentError("INPUT_SIZE", "Objective exceeds the input limit");
    if (options.parentRunId && options.snapshotRunId)
      throw new AgentError(
        "CONTINUATION",
        "A run cannot continue and snapshot another run at the same time",
      );
    const workspace = options.workspace
      ? await realpath(resolve(options.workspace))
      : undefined;
    if (options.kind === "coding" && !workspace)
      throw new AgentError("WORKSPACE", "Coding requires --workspace");
    if (workspace) await ensureOutsideWorkspace(this.paths, workspace);
    const prepared = [...(options.preparedInputs ?? [])],
      inputPlans: Array<
        | { kind: "git"; selection: GitInputSelection }
        | { kind: "file"; path: string; token: string; size: number }
      > = [];
    const redactedIds = new Set(options.contextState?.redactedImageIds ?? []);
    const excludedIds = new Set(options.contextState?.excludedSourceIds ?? []);
    const excludedHashes = new Set(
      options.contextState?.excludedSourceHashes ?? [],
    );
    const excludedUrls = new Set(
      options.contextState?.excludedSourceUrls ?? [],
    );
    if (
      options.images?.some(
        (image) =>
          excludedIds.has(image.id) || excludedHashes.has(image.sha256),
      ) ||
      prepared.some(({ images }) =>
        images?.some(
          (image) =>
            excludedIds.has(image.id) || excludedHashes.has(image.sha256),
        ),
      )
    )
      throw new AgentError(
        "SOURCE_EXCLUDED",
        "Image belongs to an excluded source family",
      );
    if (
      redactedIds.size &&
      (prepared.some(({ reference }) => reference.format === "git") ||
        options.inputs?.some((input) => input.startsWith("git:")))
    )
      throw new AgentError(
        "GIT_REDACTED",
        "Git inputs are unavailable after image redaction",
      );
    if (prepared.length + (options.inputs?.length ?? 0) > maxPreparedDocuments)
      throw new AgentError(
        "INPUT_SIZE",
        `At most ${maxPreparedDocuments} documents may be attached to one request`,
      );
    let rawInputBytes = 0,
      selectedInputBytes = Buffer.byteLength(options.objective);
    for (const { reference } of prepared) {
      if (
        excludedIds.has(reference.id) ||
        excludedHashes.has(reference.rawSha256) ||
        excludedHashes.has(reference.selectedSha256)
      )
        throw new AgentError(
          "SOURCE_EXCLUDED",
          "Prepared attachment belongs to an excluded source family",
        );
      if (
        !Number.isSafeInteger(reference.rawBytes) ||
        reference.rawBytes < 0 ||
        reference.rawBytes > maxDocumentBytes ||
        !Number.isSafeInteger(reference.selectedBytes) ||
        reference.selectedBytes < 0 ||
        reference.selectedBytes > maxDocumentBytes
      )
        throw new AgentError(
          "INPUT_INTEGRITY",
          "Prepared attachment has invalid byte counts",
        );
      rawInputBytes += reference.rawBytes;
      selectedInputBytes += reference.selectedBytes;
    }
    if (rawInputBytes > maxPreparedInputBytes)
      throw new AgentError(
        "INPUT_SIZE",
        "Cumulative document attachments exceed the raw input budget",
      );
    if (selectedInputBytes > this.config.limits.maxInputBytes)
      throw new AgentError(
        "INPUT_SIZE",
        "Request and selected attachments exceed the input limit",
      );
    for (const token of options.inputs ?? []) {
      if (token.startsWith("git:")) {
        if (!workspace)
          throw new AgentError("WORKSPACE", "Git inputs require --workspace");
        const selection = await selectGitInput(
          workspace,
          token,
          Math.min(
            maxDocumentBytes,
            this.config.limits.maxFileBytes,
            this.config.limits.maxInputBytes - selectedInputBytes,
          ),
          AbortSignal.timeout(30000),
        );
        rawInputBytes += selection.raw.length;
        selectedInputBytes += Buffer.byteLength(selection.text);
        if (rawInputBytes > maxPreparedInputBytes)
          throw new AgentError(
            "INPUT_SIZE",
            "Cumulative document attachments exceed the raw input budget",
          );
        if (selectedInputBytes > this.config.limits.maxInputBytes)
          throw new AgentError(
            "INPUT_SIZE",
            "Request and selected attachments exceed the input limit",
          );
        inputPlans.push({ kind: "git", selection });
        continue;
      }
      const parsed = parseDocumentToken(token);
      if (parsed.skill && !workspace)
        throw new AgentError(
          "WORKSPACE",
          "Skill inputs require --workspace and a workspace-relative SKILL.md path",
        );
      const path = parsed.skill
        ? await safePath(workspace!, parsed.path)
        : resolve(parsed.path);
      if (secretPath(parsed.path))
        throw new AgentError(
          "INPUT",
          "Credential-like input filenames are excluded",
        );
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size > (parsed.skill ? maxSkillBytes : maxDocumentBytes)
      )
        throw new AgentError(
          "PATH_DENIED",
          "Document input must be a bounded regular non-linked file",
        );
      rawInputBytes += info.size;
      if (rawInputBytes > maxPreparedInputBytes)
        throw new AgentError(
          "INPUT_SIZE",
          "Cumulative document attachments exceed the raw input budget",
        );
      inputPlans.push({
        kind: "file",
        path,
        token,
        size: info.size,
      });
    }
    const images = mergeImageReferences(
      options.images ?? [],
      prepared.flatMap((input) => input.images ?? []),
    );
    if (
      images.some((image) =>
        options.contextState?.redactedImageIds?.includes(image.id),
      )
    )
      throw new AgentError(
        "IMAGE_REDACTED",
        "A redacted image cannot be included in a follow-up request",
      );
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
      conversationId: options.conversationId,
      context: options.context,
      contextState: options.contextState,
      constraints: options.constraints,
      access:
        options.access ?? (options.kind === "chat" ? "read-only" : "change"),
      compactions: options.compactions,
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
      preparedInputs: options.preparedInputs?.map(({ reference }) =>
        structuredClone(reference),
      ),
      planAttempts: 0,
      repairAttempts: 0,
    };
    if (options.snapshotRunId && run.access !== "read-only")
      throw new AgentError(
        "CONTINUATION",
        "A working-copy snapshot is only available to read-only runs",
      );
    const sourceRunId = options.snapshotRunId ?? options.parentRunId;
    const sourceRun = sourceRunId
      ? (this.store.assertIdle(sourceRunId), this.store.get(sourceRunId))
      : undefined;
    if (sourceRun) {
      if (sourceRun.forkCheckpointId) {
        const lineage = options.conversationId
          ? this.store.lineage(options.conversationId)
          : undefined;
        if (
          !lineage ||
          sourceRun.conversationId !== options.conversationId ||
          !this.store.db
            .prepare(
              "SELECT 1 FROM conversation_runs WHERE session_id=? AND run_id=?",
            )
            .get(options.conversationId!, sourceRun.id) ||
          lineage.child_session_id !== options.conversationId ||
          lineage.checkpoint_id !== sourceRun.forkCheckpointId
        )
          throw new AgentError(
            "SOURCE",
            "Branch checkpoint must remain owned by its child conversation",
          );
      }
      if (
        ["public", "private", "restricted"].indexOf(run.dataClass) <
          ["public", "private", "restricted"].indexOf(sourceRun.dataClass) ||
        (sourceRun.localOnly && !run.localOnly)
      )
        throw new AgentError(
          "DISCLOSURE_DENIED",
          "A continued working copy cannot widen disclosure permissions",
        );
      if (
        this.store
          .operations(sourceRun.id)
          .some(
            (operation) =>
              ["prepared", "dispatched", "unknown"].includes(
                operation.status,
              ) ||
              (operation.name === "apply" && operation.status === "completed"),
          )
      )
        throw new AgentError(
          "UNKNOWN_OPERATION",
          "Reconcile pending operations or refresh the applied baseline before continuing",
        );
      if (options.snapshotRunId) {
        if (
          !sourceRun.prepared ||
          sourceRun.kind !== "coding" ||
          sourceRun.workspace !== workspace
        )
          throw new AgentError(
            "CONTINUATION",
            "Latest coding copy cannot be used as a read-only snapshot",
          );
      } else if (
        !sourceRun.prepared ||
        sourceRun.workspace !== workspace ||
        (sourceRun.kind !== run.kind &&
          !(
            ["writing", "research"].includes(sourceRun.kind) &&
            ["writing", "research"].includes(run.kind)
          ))
      )
        throw new AgentError(
          "CONTINUATION",
          "Previous working copy does not match this request",
        );
    }
    const conversationSourceRuns = [];
    for (const sourceRunId of new Set(options.sourceRunIds ?? [])) {
      this.store.assertIdle(sourceRunId);
      const linkedRun = this.store.get(sourceRunId);
      const linked =
        options.conversationId &&
        this.store.db
          .prepare(
            "SELECT 1 FROM conversation_runs WHERE session_id=? AND run_id=?",
          )
          .get(options.conversationId, sourceRunId);
      if (
        !linked ||
        (linkedRun.conversationId &&
          linkedRun.conversationId !== options.conversationId)
      )
        throw new AgentError(
          "SOURCE",
          "Source references must belong to this conversation",
        );
      if (linkedRun.forkCheckpointId) {
        const lineage = options.conversationId
          ? this.store.lineage(options.conversationId)
          : undefined;
        if (
          !lineage ||
          lineage.child_session_id !== options.conversationId ||
          lineage.checkpoint_id !== linkedRun.forkCheckpointId
        )
          throw new AgentError(
            "SOURCE",
            "Branch checkpoint must remain owned by its child conversation",
          );
      }
      if (
        ["public", "private", "restricted"].indexOf(run.dataClass) <
          ["public", "private", "restricted"].indexOf(linkedRun.dataClass) ||
        (linkedRun.localOnly && !run.localOnly)
      )
        throw new AgentError(
          "DISCLOSURE_DENIED",
          "A source reference cannot widen disclosure permissions",
        );
      conversationSourceRuns.push(linkedRun);
    }
    const redactedHashes = new Set([
      ...(options.redactedImageHashes ?? []),
      ...excludedHashes,
      ...[...redactedIds]
        .filter((imageId) => /^img-[a-f0-9]{64}$/.test(imageId))
        .map((imageId) => imageId.slice(4)),
    ]);
    if (redactedIds.size) {
      const linkedRunIds = options.conversationId
        ? (
            this.store.db
              .prepare(
                "SELECT run_id FROM conversation_runs WHERE session_id=?",
              )
              .all(options.conversationId) as { run_id: string }[]
          ).map(({ run_id }) => run_id)
        : [];
      for (const linkedRunId of new Set([
        ...linkedRunIds,
        ...conversationSourceRuns.map((item) => item.id),
        ...(sourceRun ? [sourceRun.id] : []),
      ])) {
        this.store.assertIdle(linkedRunId);
        const linkedRun = this.store.get(linkedRunId);
        for (const artifact of this.store
          .artifacts(linkedRun.id)
          .filter(
            (item) =>
              item.runId === linkedRun.id &&
              item.kind === "source" &&
              item.metadata.format === "git",
          ))
          redactedHashes.add(artifact.sha256);
      }
    }
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
      for (const linkedRun of conversationSourceRuns)
        this.store.inheritSources(
          linkedRun.id,
          owned.id,
          !linkedRun.forkCheckpointId,
          !!options.contextState?.redactedImageIds?.length,
          [...excludedIds],
          [...excludedHashes],
          [...excludedUrls],
        );
      if (options.snapshotRunId) {
        await continueWorkspace(
          this.store.runDir(sourceRun!.id),
          directory,
          this.config,
        );
        this.store.inheritSources(
          sourceRun!.id,
          owned.id,
          false,
          !!options.contextState?.redactedImageIds?.length,
          [...excludedIds],
          [...excludedHashes],
          [...excludedUrls],
        );
        await sanitizeWorkCopy(
          directory,
          [...redactedHashes],
          this.config.limits.maxWorkspaceBytes,
        );
      } else if (options.parentRunId) {
        await continueWorkspace(
          this.store.runDir(sourceRun!.id),
          directory,
          this.config,
        );
        await sanitizeWorkCopy(
          directory,
          [...redactedHashes],
          this.config.limits.maxWorkspaceBytes,
        );
        // Source IDs remain stable so existing citations continue to resolve.
        this.store.inheritSources(
          sourceRun!.id,
          owned.id,
          false,
          !!options.contextState?.redactedImageIds?.length,
          [...excludedIds],
          [...excludedHashes],
          [...excludedUrls],
        );
      } else
        await snapshotWorkspace(
          directory,
          workspace,
          options.includeUntracked ?? false,
          this.config,
          options.extraPaths,
          [...redactedHashes],
        );
      if (workspace) await verifyOriginal(await readSnapshot(directory));
      let inputBytes =
        Buffer.byteLength(owned.objective) +
        prepared.reduce((sum, input) => sum + input.reference.selectedBytes, 0);
      for (const plan of inputPlans) {
        if (plan.kind === "git") {
          if (excludedHashes.has(sha256(plan.selection.raw)))
            throw new AgentError(
              "SOURCE_EXCLUDED",
              "Git attachment belongs to an excluded source family",
            );
          if (
            inputBytes + Buffer.byteLength(plan.selection.text) >
            this.config.limits.maxInputBytes
          )
            throw new AgentError(
              "INPUT_SIZE",
              "Request and selected attachments exceed the input limit",
            );
          prepared.push(await storeGitInput(this.paths, plan.selection));
        } else {
          const remainingImages =
              maxConversationImages -
              new Set(
                [
                  ...(owned.images ?? []),
                  ...prepared.flatMap((input) => input.images ?? []),
                ].map((image) => image.id),
              ).size,
            input = await prepareDocument(
              this.paths,
              plan.path,
              plan.token,
              this.config.limits.maxInputBytes - inputBytes,
              {
                sandbox: this.sandbox,
                dataClass: owned.dataClass,
                localOnly: owned.localOnly,
                expectedBytes: plan.size,
                remainingImages: Math.max(0, remainingImages),
                signal: AbortSignal.timeout(30000),
              },
            );
          prepared.push(input);
          if (
            excludedIds.has(input.reference.id) ||
            excludedHashes.has(input.reference.rawSha256) ||
            excludedHashes.has(input.reference.selectedSha256)
          )
            throw new AgentError(
              "SOURCE_EXCLUDED",
              "Attachment belongs to an excluded source family",
            );
        }
        inputBytes += prepared.at(-1)!.reference.selectedBytes;
        if (inputBytes > this.config.limits.maxInputBytes)
          throw new AgentError(
            "INPUT_SIZE",
            "Request and attachments exceed the input limit",
          );
      }
      owned.preparedInputs = prepared.map(({ reference }) =>
        structuredClone(reference),
      );
      let loadedInputBytes = Buffer.byteLength(owned.objective);
      for (const [index, input] of prepared.entries()) {
        const loaded = await loadPreparedInput(this.paths, input.reference);
        loadedInputBytes += Buffer.byteLength(loaded.text);
        if (loadedInputBytes > this.config.limits.maxInputBytes)
          throw new AgentError(
            "INPUT_SIZE",
            "Request and attachments exceed the input limit",
          );
        if (
          input.reference.imageIds?.some(
            (id) => !(input.images ?? []).some((image) => image.id === id),
          )
        )
          throw new AgentError(
            "INPUT_INTEGRITY",
            "Prepared PDF images are missing",
          );
        if (input.images?.some((image) => redactedIds.has(image.id)))
          throw new AgentError(
            "IMAGE_REDACTED",
            "A redacted image cannot be introduced by a prepared attachment",
          );
        owned.images = mergeImageReferences(
          owned.images ?? [],
          input.images ?? [],
        );
        if (
          owned.images.length > maxConversationImages ||
          owned.images.reduce((sum, image) => sum + image.bytes, 0) >
            maxConversationImageBytes
        )
          throw new AgentError(
            "IMAGE_LIMIT",
            "Prepared document images exceed the conversation image limit",
          );
        const name = `inputs/${index + 1}-${input.reference.originalName}`;
        // A coding reference must not introduce an inputs/ file into the applied patch.
        if (run.kind !== "coding")
          await atomicWrite(join(directory, "work", name), loaded.text);
        const source = await this.store.artifact(
          owned,
          name,
          "source",
          loaded.text,
          {
            input: true,
            sourceId: input.reference.id,
            sourcePath: input.reference.originalName,
            rawSha256: input.reference.rawSha256,
            selectedSha256: input.reference.selectedSha256,
            format: input.reference.format,
            selector: input.reference.selector,
            locator: input.reference.locator,
            rawBytes: input.reference.rawBytes,
            selectedBytes: input.reference.selectedBytes,
            partial: input.reference.partial,
            retrievedAt: new Date().toISOString(),
          },
        );
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
    if (run.forkCheckpointId)
      throw new AgentError(
        "FORK_SEED",
        "保存状態復元シードは推論・実行に使用できません。",
      );
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
      this.approveTool,
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
      assertContextReady(run);
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
          `${unknown.length} operations need reconciliation; use agent process stop for managed processes, and agent reconcile for other operations`,
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
      if (
        run.access !== "read-only" &&
        run.kind === "coding" &&
        !run.checks.length
      )
        throw new AgentError(
          "CHECK_CONFIG",
          "Coding requires at least one --check from the trusted configuration",
        );
      if (
        run.access !== "read-only" &&
        (run.kind === "coding" || run.checks.length)
      ) {
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
            (tasks) =>
              this.planner.admitDelegations(run, tasks, controller.signal),
          );
        } catch (error) {
          if (
            error instanceof AgentError &&
            ["TASK_FAILED", "INVALID_RESULT", "ARTIFACT_MISSING"].includes(
              error.code,
            )
          ) {
            const failedTask = run.tasks.find(
                (task) => task.state === "failed",
              ),
              feedback = failedTask
                ? [
                    error.message,
                    `Failed task: ${failedTask.id}`,
                    ...(failedTask.result?.unresolved ?? []).map(
                      (finding) => `Unresolved finding: ${finding}`,
                    ),
                    ...(failedTask.attemptReportIds ?? []).map(
                      (reportId) => `Attempt report: ${reportId}`,
                    ),
                  ].join("\n")
                : error.message;
            await this.repair(run, feedback, work);
            continue;
          }
          throw error;
        }
        controller.signal.throwIfAborted();
        if (acceptInstructions()) continue;
        this.store.assertManagedProcessesStopped(run);
        if (this.store.operations(run.id).some((o) => o.status === "unknown"))
          throw new AgentError(
            "UNKNOWN_OPERATION",
            "An operation needs reconciliation before validation",
          );
        if (run.access === "read-only") {
          await closeResources();
          await recordTaskModelChangeResolution(
            this.store,
            run,
            [],
            true,
            this.config.limits.maxFileBytes,
          );
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
        this.store.transition(run, "validating");
        this.notify("validation_started", {
          runId: run.id,
          generation: run.generation,
        });
        const priorCheckIds = new Set(
          this.store
            .artifacts(run.id)
            .filter((artifact) => artifact.kind === "check")
            .map((artifact) => artifact.id),
        );
        const checks = await this.evaluator.validate(run, controller.signal);
        this.notify("validation", { runId: run.id, checks });
        if (acceptInstructions()) {
          this.store.transition(run, "running");
          continue;
        }
        if (checks.every((check) => check.passed)) {
          await this.evaluator.verifyPublished(run);
          const freshCheckIds = this.store
            .artifacts(run.id)
            .filter(
              (artifact) =>
                artifact.kind === "check" && !priorCheckIds.has(artifact.id),
            )
            .map((artifact) => artifact.id);
          await recordTaskModelChangeResolution(
            this.store,
            run,
            freshCheckIds,
            false,
            this.config.limits.maxFileBytes,
          );
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
          .some(
            (operation) =>
              operation.status === "unknown" ||
              (operation.name === "process_start" &&
                operation.status === "dispatched"),
          ),
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
    const readOnlyCollaboration =
      isCollaborative(run) &&
      run.access === "read-only" &&
      run.tasks.every((task) => task.resultFormat === "structured");
    if (run.access === "read-only" && !readOnlyCollaboration)
      throw new AgentError("TASK_FAILED", feedback);
    if (readOnlyCollaboration) {
      const failed = run.tasks.find((task) => task.state === "failed");
      if (!failed) throw new AgentError("TASK_FAILED", feedback);
      const target =
        failed.role === "reviewer" || failed.purpose === "synthesis"
          ? this.nearestProducerAncestor(run, failed)
          : failed;
      if (!target) throw new AgentError("VALIDATION_FAILED", feedback);
      const ancestors = this.taskAncestors(run, target),
        fingerprint = sha256(
          canonical({
            feedback,
            outcomes: [target, ...ancestors]
              .map((task) => ({
                role: task.role,
                purpose: task.purpose,
                outcome: task.result?.outcome,
                summary: task.result?.summary,
                artifacts: task.result?.artifacts,
                unresolved: task.result?.unresolved,
              }))
              .sort((left, right) =>
                canonical(left).localeCompare(canonical(right)),
              ),
          }),
        );
      if (
        run.repairAttempts >= this.config.limits.maxRepairs ||
        fingerprint === run.lastFailureFingerprint
      )
        throw new AgentError("VALIDATION_FAILED", feedback);
      run.repairAttempts++;
      run.lastFailureFingerprint = fingerprint;
      target.reworkLinks ??= [];
      target.reworkLinks.push({
        priorReportIds: [
          ...new Set([
            ...(target.attemptReportIds ?? []),
            ...(failed.attemptReportIds ?? []),
          ]),
        ],
        reason: feedback.slice(0, 4000),
        repairAttempt: run.repairAttempts,
        status: "pending",
      });
      const invalidated = new Set([target.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const task of run.tasks)
          if (
            !invalidated.has(task.id) &&
            task.dependsOn.some((dependency) => invalidated.has(dependency))
          ) {
            invalidated.add(task.id);
            changed = true;
          }
      }
      this.store.transition(run, "repairing");
      for (const task of run.tasks)
        if (invalidated.has(task.id)) {
          task.state = "pending";
          task.result = undefined;
        }
      this.store.save(run, "repair_requested", {
        taskId: target.id,
        priorReportIds: target.reworkLinks.at(-1)?.priorReportIds,
        feedback: feedback.slice(0, 4000),
        attempt: run.repairAttempts,
      });
      this.store.transition(run, "running");
      return;
    }
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
    writer.reworkLinks ??= [];
    writer.reworkLinks.push({
      priorReportIds: [...(writer.attemptReportIds ?? [])],
      reason: feedback.slice(0, 4000),
      repairAttempt: run.repairAttempts,
      status: "pending",
    });
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

  private taskAncestors(run: Run, task: Task): Task[] {
    const found = new Map<string, Task>();
    const visit = (taskId: string) => {
      const dependency = run.tasks.find((candidate) => candidate.id === taskId);
      if (!dependency || found.has(dependency.id)) return;
      found.set(dependency.id, dependency);
      for (const parentId of dependency.dependsOn) visit(parentId);
    };
    for (const dependencyId of task.dependsOn) visit(dependencyId);
    return [...found.values()];
  }

  private nearestProducerAncestor(run: Run, task: Task): Task | undefined {
    const ancestors = this.taskAncestors(run, task),
      distances = new Map<string, number>();
    const visit = (current: Task, distance: number) => {
      for (const dependencyId of current.dependsOn) {
        if ((distances.get(dependencyId) ?? Infinity) <= distance) continue;
        distances.set(dependencyId, distance);
        const dependency = run.tasks.find(
          (candidate) => candidate.id === dependencyId,
        );
        if (dependency) visit(dependency, distance + 1);
      }
    };
    visit(task, 1);
    return ancestors
      .filter(
        (candidate) =>
          candidate.role === "worker" && candidate.purpose !== "synthesis",
      )
      .sort(
        (left, right) =>
          (distances.get(left.id) ?? Infinity) -
          (distances.get(right.id) ?? Infinity),
      )[0];
  }
}
