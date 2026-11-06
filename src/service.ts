import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  Harness,
  createRegistry,
  configure,
  ProviderDoc,
  LiveDoc,
  UsageDoc,
} from "@earendil-works/pi-durable";
import type {
  Storage,
  Tx,
  ToolExecutionApi,
  Cursor,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Config } from "./config.js";
import { privateFile } from "./config.js";
import { AppDoc, terminal, touch } from "./state.js";
import type {
  AppState,
  Job,
  Operation,
  Artifact,
  GithubPayload,
  WaitReason,
} from "./state.js";
import {
  AppError,
  hash,
  publicRepo,
  safeRelative,
  byteHash,
} from "./security.js";
import { guardedProvider } from "./provider.js";
import { ArtifactStore } from "./artifacts.js";
import { WorkerClient } from "./execution/client.js";
import type {
  Runner,
  WorkerRequest,
  WorkerResult,
} from "./execution/protocol.js";
import { GithubConnector, githubHttp } from "./integrations/github.js";
import { agentTools, instructions } from "./tools.js";

export type CreateJob = {
  requestId: string;
  title: string;
  objective: string;
  kind: "code" | "research";
  acceptance: string[];
  parentId?: string;
  project: string;
  repoUrl?: string;
  attachmentIds: string[];
  externalAllowed: boolean;
};
export type ServiceOptions = {
  runner?: Runner;
  provider?: Provider;
  modelId?: string;
  github?: GithubConnector;
  storage?: Storage;
  secrets?: string[];
  now?: () => number;
};
const unresolved = (job: Job) =>
  job.operations.filter((op) => ["dispatched", "unknown"].includes(op.status));
export class AgentService {
  harness!: Harness;
  readonly runner: Runner;
  readonly artifacts: ArtifactStore;
  readonly uploads: ArtifactStore;
  github?: GithubConnector;
  private timer?: NodeJS.Timeout;
  private activeRun?: Promise<void>;
  private scheduling = false;
  private stopping = false;
  private fatal = false;
  private providerReady = false;
  private configuredModel: string | null;
  private secrets: string[];
  private now: () => number;
  private stops = new Map<string, Promise<void>>();
  private externalRuns = new Map<string, Promise<void>>();
  private cleanupProbed = new Set<string>();
  private runSignals = new Map<string, AbortController>();
  private initializations = new Map<string, Promise<void>>();
  private failureReason = "storage";
  private modelIssue = "unconfigured";
  readonly notifications = new Set<() => void>();
  private constructor(
    readonly config: Config,
    private options: ServiceOptions,
  ) {
    this.runner = options.runner ?? new WorkerClient();
    this.artifacts = new ArtifactStore(
      join(config.dataRoot, "control/artifacts"),
    );
    this.uploads = new ArtifactStore(join(config.dataRoot, "control/uploads"));
    this.configuredModel = options.modelId ?? config.model?.id ?? null;
    this.secrets = options.secrets ?? [];
    this.now = options.now ?? Date.now;
  }
  static async open(
    config: Config,
    options: ServiceOptions = {},
  ): Promise<AgentService> {
    const service = new AgentService(config, options);
    await service.open();
    return service;
  }
  private async open(): Promise<void> {
    const credentials = new InMemoryCredentialStore(),
      models = createModels({ credentials });
    let provider = this.options.provider;
    if (!provider && this.config.model) {
      try {
        const key = await privateFile(this.config.model.keyFile);
        if (key) {
          await credentials.modify("openai", async () => ({
            type: "api_key",
            key,
          }));
          this.secrets.push(key);
          provider = openaiProvider();
        } else this.modelIssue = "missing_key";
      } catch {
        this.modelIssue = "missing_key";
      }
    }
    if (provider) {
      this.providerReady = true;
      this.modelIssue = "ready";
      models.setProvider(
        guardedProvider(
          provider,
          (session, model) => this.reserve(session, model),
          (message, session, model) =>
            this.providerError(message, session, model),
        ),
      );
    }
    if (this.config.github && !this.options.github) {
      try {
        const token = await privateFile(this.config.github.tokenFile);
        if (token) {
          this.secrets.push(token);
          this.github = new GithubConnector(
            this.config.github.repositories,
            githubHttp(token),
          );
        }
      } catch {
        this.github = undefined;
      }
    } else this.github = this.options.github;
    const registry = createRegistry();
    registry.install(agentTools(this));
    const existing =
      !this.options.storage &&
      (await stat(join(this.config.dataRoot, "control/state.sqlite")).catch(
        () => null,
      ));
    this.harness = await Harness.open(
      this.options.storage ??
        (await openNodeSqliteStorage(
          join(this.config.dataRoot, "control/state.sqlite"),
        )),
      {
        models,
        registry,
        settings: {
          toolExecution: "sequential",
          retry: {
            enabled: true,
            maxRetries: 3,
            baseDelayMs: 500,
            maxAgentDelayMs: 5000,
          },
          compaction: { enabled: true, backgroundTokens: 0 },
          stream: { maxRetries: 0, timeoutMs: 120000 },
          restartLimit: 3,
          afterFailedRun: "keep",
        },
        onReport: (report) => {
          if (report.kind === "storage_failed") {
            this.fatal = true;
            if (
              report.error &&
              typeof report.error === "object" &&
              "code" in report.error &&
              report.error.code === "ENOSPC"
            )
              this.failureReason = "capacity";
            this.notify();
          }
        },
      },
      ctx,
    );
    if (
      existing &&
      existing.size > 0 &&
      !(await this.harness.snapshot(AppDoc, ctx))
    ) {
      await this.harness.close(ctx);
      throw new AppError(
        503,
        "未知の保存形式です。元のデータを保持して確認してください",
      );
    }
    await this.harness.commit(async (tx) => {
      const app = await tx.doc(AppDoc);
      if (app.schemaVersion !== 1)
        throw new AppError(503, "保存形式に互換性がありません");
      const crashed = !app.cleanShutdown;
      app.cleanShutdown = false;
      app.recoveryHold ||= this.config.recoveryHold;
      for (const job of app.jobs) {
        for (const operation of job.operations)
          if (operation.status === "dispatched") operation.status = "unknown";
        if (terminal(job)) {
          if (
            app.activeJobId === job.id &&
            ((crashed && job.externalAllowed) || app.recoveryHold)
          )
            job.recoveryRequired = true;
          if (
            unresolved(job).length ||
            job.recoveryRequired ||
            !job.cleanupConfirmed
          ) {
            app.activeJobId ??= job.id;
            job.detail = "終了後の操作結果または子プロセスの確認が必要です";
            touch(job);
          }
          continue;
        }
        if ((crashed && job.externalAllowed) || app.recoveryHold)
          job.recoveryRequired = true;
        if (
          job.status === "running" ||
          unresolved(job).length ||
          job.recoveryRequired
        ) {
          job.status = "waiting";
          job.waitReason =
            unresolved(job).length || job.recoveryRequired
              ? "reconciliation"
              : "user";
          job.detail =
            job.waitReason === "reconciliation"
              ? "前回の処理結果を確認してから再開してください"
              : "サービスの再起動後です。確認して再開してください";
          job.cleanupConfirmed = false;
          app.activeJobId ??= job.id;
          touch(job);
        }
      }
    }, ctx);
    // No scheduler is resumed until the persisted job and provider gates exist.
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        this.fatal = true;
        this.notify();
      });
    }, 100);
    this.timer.unref();
    void this.harness.closed.then((end) => {
      if (!this.stopping) {
        this.fatal = true;
        this.notify();
      }
      void end;
    });
  }
  healthy(): boolean {
    return !this.fatal && !this.stopping;
  }
  modelState(): string {
    return this.modelIssue;
  }
  private assertHealthy(): void {
    if (!this.healthy())
      throw new AppError(
        this.failureReason === "capacity" ? 507 : 503,
        this.failureReason === "capacity"
          ? "データディスクの容量が不足しています。容量を確保してサービスを再起動してください"
          : "保存基盤を停止しています。サービスの診断・再起動が必要です",
      );
  }
  redact(text: string): string {
    for (const secret of this.secrets)
      if (secret) text = text.split(secret).join("[REDACTED]");
    return text
      .replace(/(authorization\s*[:=]\s*)([^\n\r]+)/gi, "$1[REDACTED]")
      .replace(/(cookie\s*[:=]\s*)([^\n\r]+)/gi, "$1[REDACTED]");
  }
  private notify(): void {
    for (const listener of this.notifications) listener();
  }
  async snapshot(): Promise<Readonly<AppState>> {
    this.assertHealthy();
    return (await this.harness.snapshot(AppDoc, ctx))!;
  }
  async job(id: string): Promise<Job> {
    const job = (await this.snapshot()).jobs.find((job) => job.id === id);
    if (!job) throw new AppError(404, "仕事がありません");
    return structuredClone(job);
  }
  private find(app: AppState, id: string): Job {
    const job = app.jobs.find((job) => job.id === id);
    if (!job) throw new AppError(404, "仕事がありません");
    return job;
  }
  private async update(
    id: string,
    change: (job: Job, app: AppState) => void,
  ): Promise<void> {
    this.assertHealthy();
    await this.harness.commit(async (tx) => {
      const app = await tx.doc(AppDoc),
        job = this.find(app, id);
      change(job, app);
      touch(job);
    }, ctx);
    this.notify();
  }
  private async request(
    requestId: string,
    kind: string,
    payload: unknown,
    action: (app: AppState, tx: Tx) => Promise<{ id: string }> | { id: string },
  ): Promise<{ id: string }> {
    this.assertHealthy();
    const argumentHash = hash({ kind, payload });
    const result = await this.harness.commit(async (tx) => {
      const app = await tx.doc(AppDoc),
        receipt = app.receipts[requestId];
      if (receipt) {
        if (receipt.hash !== argumentHash)
          throw new AppError(409, "同じ requestId の内容が一致しません");
        return { id: receipt.result.id };
      }
      const result = await action(app, tx);
      app.receipts[requestId] = { hash: argumentHash, result };
      return result;
    }, ctx);
    this.notify();
    return result;
  }
  async create(input: CreateJob): Promise<{ id: string }> {
    if (input.repoUrl) publicRepo(input.repoUrl);
    return this.request(input.requestId, "create", input, async (app, tx) => {
      if (app.jobs.length >= 1000)
        throw new AppError(
          507,
          "仕事の保存上限に達しました。別データセットを用意してください",
        );
      if (input.parentId && !terminal(this.find(app, input.parentId)))
        throw new AppError(409, "元の仕事が終了していません");
      const parent = input.parentId
        ? this.find(app, input.parentId)
        : undefined;
      const parentArtifacts = parent
        ? [
            ...new Map(
              parent.artifacts
                .filter(
                  (artifact) =>
                    !/^(command-|self-review-|source-|pdf-inspection-)/.test(
                      artifact.name,
                    ) && artifact.mediaType !== "image/png",
                )
                .map((artifact) => [artifact.name, artifact]),
            ).values(),
          ]
        : [];
      if (
        parentArtifacts.some(
          (artifact) => artifact.size > this.config.limits.uploadBytes,
        ) ||
        parentArtifacts.reduce((sum, artifact) => sum + artifact.size, 0) >
          this.config.limits.uploadTotalBytes
      )
        throw new AppError(
          413,
          "前の成果物が添付上限を超えています。必要なファイルを選んで新規依頼してください",
        );
      const inheritedRepo = input.repoUrl ?? parent?.repoUrl;
      const uploads = input.attachmentIds.map((id) => {
        const upload = app.uploads.find((item) => item.id === id);
        if (!upload) throw new AppError(404, "添付がありません");
        return upload;
      });
      if (
        uploads.reduce((sum, upload) => sum + upload.size, 0) +
          parentArtifacts.reduce((sum, artifact) => sum + artifact.size, 0) >
        this.config.limits.uploadTotalBytes
      )
        throw new AppError(413, "仕事の添付上限を超えています");
      const conversation = await tx.createConversation({
        ownership: { kind: "ownerless" },
      });
      const id = randomUUID(),
        timestamp = new Date(this.now()).toISOString();
      const job: Job = {
        schemaVersion: 1,
        id,
        conversationId: conversation.id,
        status: "queued",
        detail: "実行待ち",
        title: input.title,
        objective: input.objective,
        kind: input.kind,
        acceptance: input.acceptance,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        project: input.project,
        ...(inheritedRepo ? { repoUrl: inheritedRepo } : {}),
        parentArtifactIds: parentArtifacts.map((artifact) => artifact.id),
        attachmentIds: input.attachmentIds,
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 1,
        policyRevision: 1,
        modelId: this.configuredModel,
        instructions: [
          app.settings.commonInstructions,
          app.settings.projectNotes[input.project] ?? "",
        ].join("\n"),
        limits: { ...this.config.limits },
        counters: { modelRequests: 0, repairs: 0 },
        inputs: [
          { requestId: input.requestId, text: input.objective, applied: false },
        ],
        artifacts: [],
        validations: [],
        sources: [],
        operations: [],
        approvals: [],
        workspaceRevision: 0,
        started: false,
        workspaceReady: false,
        externalAllowed: input.externalAllowed,
        allowedRepositories: input.externalAllowed
          ? [
              ...(this.config.github?.repositories ??
                this.github?.repositories ??
                []),
            ]
          : [],
        cleanupConfirmed: true,
        recoveryRequired: app.recoveryHold,
        renderPages: [],
      };
      await configure(tx, conversation.id, {
        model: this.providerReady
          ? {
              provider: this.options.provider?.id ?? "openai",
              modelId: this.configuredModel!,
            }
          : null,
        instructions: instructions(job),
        maxTurns: job.limits.modelRequests,
      });
      app.jobs.push(job);
      return { id };
    });
  }
  async input(
    id: string,
    requestId: string,
    text: string,
  ): Promise<{ id: string }> {
    const before = await this.job(id),
      conversation = (await this.harness.conversation(
        before.conversationId,
        ctx,
      ))!;
    return this.request(requestId, "input", { id, text }, async (app, tx) => {
      const job = this.find(app, id);
      if (terminal(job))
        throw new AppError(
          409,
          "終了した仕事の続きは新しい仕事として依頼してください",
        );
      if (job.inputs.length >= 100)
        throw new AppError(413, "追加指示の上限に達しました");
      const submissionId =
        job.status === "running" && job.started
          ? await conversation.submit(tx, {
              type: "input",
              content: text,
              requestId,
              whenBusy: "steer",
            })
          : undefined;
      job.inputs.push({
        requestId,
        text,
        ...(submissionId ? { submissionId } : {}),
        applied: false,
      });
      touch(job);
      return { id };
    });
  }
  async action(
    id: string,
    requestId: string,
    revision: number,
    action: "pause" | "resume" | "cancel",
    extensionSeconds?: number,
    additionalModelRequests?: number,
    useConfiguredModel = false,
  ): Promise<{ id: string }> {
    const result = await this.request(
      requestId,
      "action",
      {
        id,
        revision,
        action,
        extensionSeconds,
        additionalModelRequests,
        useConfiguredModel,
      },
      (app) => {
        const job = this.find(app, id);
        if (job.revision !== revision)
          throw new AppError(
            409,
            "仕事が更新されています。最新状態を確認してください",
          );
        if (terminal(job))
          throw new AppError(409, "終了した仕事は変更できません");
        if (action === "resume") {
          if (
            job.status !== "waiting" ||
            unresolved(job).length ||
            job.recoveryRequired ||
            app.recoveryHold ||
            this.stops.has(id)
          )
            throw new AppError(
              409,
              "停止処理・未知操作・復旧待ちを先に確認してください",
            );
          if (
            job.operations.some(
              (operation) =>
                operation.kind === "github" && operation.status === "prepared",
            )
          )
            throw new AppError(
              409,
              "外部変更の提案を承認または拒否してから再開してください",
            );
          if (useConfiguredModel && !this.providerReady)
            throw new AppError(409, "切替先モデルを設定してください");
          if (useConfiguredModel && job.modelId !== this.configuredModel) {
            job.modelId = this.configuredModel;
            job.policyRevision++;
            delete job.completion;
          }
          if (extensionSeconds)
            job.deadlineAt = this.now() + extensionSeconds * 1000;
          if (additionalModelRequests)
            job.limits.modelRequests = Math.min(
              600,
              job.limits.modelRequests + additionalModelRequests,
            );
          if (!job.modelId && this.providerReady)
            job.modelId = this.configuredModel;
          job.status = "queued";
          delete job.waitReason;
          job.detail = "再開待ち";
        } else {
          job.status = action === "cancel" ? "cancelled" : "waiting";
          if (action === "pause") job.waitReason = "user";
          else delete job.waitReason;
          job.detail =
            action === "cancel"
              ? "取消を受理しました"
              : "一時停止を受理しました";
          job.cleanupConfirmed = !job.started && !job.workspaceReady;
        }
        touch(job);
        return { id };
      },
    );
    if (action !== "resume") {
      const app = await this.snapshot(),
        job = this.find(app, id);
      if (
        app.activeJobId === id &&
        (!job.cleanupConfirmed ||
          unresolved(job).length ||
          this.runSignals.has(id))
      ) {
        void this.stop(id).catch(() => {
          this.fatal = true;
          this.notify();
        });
      }
    }
    return result;
  }
  private async stop(id: string): Promise<void> {
    if (this.stops.has(id)) return this.stops.get(id);
    const promise = (async () => {
      this.runSignals.get(id)?.abort();
      const initialization = this.initializations.get(id);
      if (initialization) await initialization.catch(() => undefined);
      const job = await this.job(id),
        conversation = await this.harness.conversation(job.conversationId, ctx);
      await conversation?.abort(ctx);
      let cleanup = !job.workspaceReady;
      if (job.workspaceReady || initialization) {
        try {
          await this.runner.ready();
          cleanup =
            (await this.runner.call(id, "cleanup", {})).cleanup === true;
        } catch {
          cleanup = false;
        }
      }
      await this.update(id, (current, app) => {
        current.cleanupConfirmed = cleanup;
        for (const op of current.operations)
          if (op.status === "dispatched") op.status = "unknown";
        if (!cleanup || unresolved(current).length) {
          if (!terminal(current)) {
            current.status = "waiting";
            current.waitReason = "reconciliation";
          }
          current.detail = "子プロセスまたは操作結果の確認が必要です";
        } else if (
          terminal(current) &&
          !current.recoveryRequired &&
          app.activeJobId === id
        )
          app.activeJobId = null;
      });
    })().finally(() => {
      this.stops.delete(id);
    });
    this.stops.set(id, promise);
    return promise;
  }
  private async tick(): Promise<void> {
    if (!this.healthy() || this.scheduling || this.activeRun || this.stops.size)
      return;
    this.scheduling = true;
    try {
      const initial = await this.snapshot();
      const ended = initial.jobs.find((job) => job.id === initial.activeJobId);
      if (
        !initial.recoveryHold &&
        ended &&
        terminal(ended) &&
        !ended.cleanupConfirmed &&
        !ended.recoveryRequired &&
        !unresolved(ended).length &&
        !this.cleanupProbed.has(ended.id)
      ) {
        this.cleanupProbed.add(ended.id);
        await this.stop(ended.id);
        return;
      }
      let selected: string | undefined;
      await this.harness.commit(async (tx) => {
        const app = await tx.doc(AppDoc);
        if (app.recoveryHold) return;
        const active = app.activeJobId
          ? this.find(app, app.activeJobId)
          : undefined;
        if (
          active &&
          (unresolved(active).length ||
            active.recoveryRequired ||
            (terminal(active) && !active.cleanupConfirmed) ||
            active.status === "waiting")
        )
          return;
        if (active && terminal(active)) app.activeJobId = null;
        const job =
          active?.status === "queued"
            ? active
            : !app.activeJobId
              ? app.jobs.find((job) => job.status === "queued")
              : undefined;
        if (!job) return;
        app.activeJobId = job.id;
        if (job.recoveryRequired) {
          job.status = "waiting";
          job.waitReason = "reconciliation";
          job.detail = "復旧の確認が必要です";
        } else if (!this.providerReady || !job.modelId) {
          job.status = "waiting";
          job.waitReason = "credentials";
          job.detail = "モデルを設定してサービスを再起動してください";
        } else if (
          job.counters.modelRequests >= job.limits.modelRequests ||
          (job.deadlineAt && job.deadlineAt <= this.now())
        ) {
          job.status = "waiting";
          job.waitReason = "budget";
          job.detail = "回数または期限の上限です";
        } else {
          job.status = "running";
          job.deadlineAt ??= this.now() + job.limits.deadlineSeconds * 1000;
          job.detail = "作業環境を確認しています";
          selected = job.id;
        }
        touch(job);
      }, ctx);
      if (selected) {
        this.activeRun = this.run(selected)
          .catch(async () => {
            if (
              this.healthy() &&
              (await this.job(selected!)).status === "running"
            )
              await this.wait(
                selected!,
                "environment",
                "作業環境で失敗しました。状態を確認してください",
              );
          })
          .finally(() => {
            this.activeRun = undefined;
            this.runSignals.delete(selected!);
            this.notify();
          });
      }
    } finally {
      this.scheduling = false;
    }
  }
  private async wait(
    id: string,
    reason: WaitReason,
    detail: string,
  ): Promise<void> {
    await this.update(id, (job) => {
      if (terminal(job)) return;
      job.status = "waiting";
      job.waitReason = reason;
      job.detail = detail;
    });
  }
  private async run(id: string): Promise<void> {
    const controller = new AbortController();
    this.runSignals.set(id, controller);
    let job = await this.job(id);
    const deadline = setTimeout(
      () => {
        void this.wait(id, "budget", "仕事の期限に達しました")
          .then(() => this.stop(id))
          .catch(() => {
            this.fatal = true;
          });
      },
      Math.max(1, job.deadlineAt! - this.now()),
    );
    try {
      try {
        await this.runner.ready();
      } catch {
        await this.wait(
          id,
          "environment",
          "作業 UID または通信制限を確認できません。安全な実行へ切り替えることはできません",
        );
        return;
      }
      job = await this.job(id);
      if (job.status !== "running" || controller.signal.aborted) return;
      if (!job.cleanupConfirmed) {
        const cleanup = await this.runner.call(id, "cleanup", {});
        if (!cleanup.cleanup) {
          await this.wait(
            id,
            "environment",
            "前回の子プロセスを回収できません",
          );
          return;
        }
        await this.update(id, (current) => {
          current.cleanupConfirmed = true;
        });
      }
      if (!job.workspaceReady) {
        const initialization = (async () => {
          const op = await this.prepare(id, "shell", "workspace-init", {
            repoUrl: job.repoUrl,
          });
          await this.dispatch(id, op.id);
          try {
            const result = await this.runner.call(
              id,
              "init",
              { repoUrl: job.repoUrl },
              controller.signal,
            );
            if (result.exitCode)
              throw new Error("Workspace initialization failed");
            const app = await this.snapshot();
            for (const uploadId of job.attachmentIds) {
              const upload = app.uploads.find(
                (upload) => upload.id === uploadId,
              )!;
              const data = await this.uploads.read(upload);
              await this.runner.call(
                id,
                "import",
                {
                  path: `attachments/${upload.id}-${upload.name}`,
                  data: data.toString("base64"),
                },
                controller.signal,
              );
            }
            if (job.parentId) {
              const parent = app.jobs.find((item) => item.id === job.parentId)!;
              for (const artifactId of job.parentArtifactIds) {
                const artifact = parent.artifacts.find(
                  (item) => item.id === artifactId,
                )!;
                const data = await this.artifacts.read(artifact);
                await this.runner.call(
                  id,
                  "import",
                  {
                    path: `attachments/previous-${artifact.name}`,
                    data: data.toString("base64"),
                  },
                  controller.signal,
                );
              }
            }
            if (controller.signal.aborted)
              throw new Error("Initialization interrupted");
            await this.update(id, (current) => {
              current.workspaceReady = true;
              current.operations.find((item) => item.id === op.id)!.status =
                "completed";
            });
          } catch {
            await this.unknown(id, op.id);
            return;
          }
        })();
        this.initializations.set(id, initialization);
        try {
          await initialization;
        } finally {
          this.initializations.delete(id);
        }
      }
      job = await this.job(id);
      if (job.status !== "running" || this.stopping) return;
      const conversation = (await this.harness.conversation(
        job.conversationId,
        ctx,
      ))!;
      await conversation.configure(
        {
          model: {
            provider: this.options.provider?.id ?? "openai",
            modelId: job.modelId!,
          },
          instructions: instructions(job),
          maxTurns: job.limits.modelRequests,
        },
        ctx,
      );
      const inspection = await this.harness.inspect(ctx);
      const pending = inspection.tasks.some(
        (task) => task.record.conversationId === job.conversationId,
      );
      if (!pending) {
        await this.harness.commit(async (tx) => {
          const app = await tx.doc(AppDoc),
            current = this.find(app, id);
          if (current.status !== "running") return;
          const unapplied = current.inputs.filter((input) => !input.applied);
          const content = unapplied.length
            ? unapplied.map((input) => input.text).join("\n\n")
            : "停止前の記録と作業ファイルを確認し、未完了の仕事を続けてください。中断した Shell や外部変更を無条件に再実行しないでください。";
          const submissionId = await conversation.submit(tx, {
            type: "input",
            content,
            requestId: `job:${id}:run:${current.revision}`,
            whenBusy: "steer",
          });
          for (const input of unapplied) input.submissionId = submissionId;
          current.started = true;
          current.detail = "依頼を実行しています";
          touch(current);
        }, ctx);
      }
      this.harness.resume();
      while (true) {
        await conversation.waitForIdle(ctx);
        await this.refreshInputs(id);
        job = await this.job(id);
        if (job.status !== "running" || this.stopping) return;
        const live = await this.harness.snapshot(
          LiveDoc,
          job.conversationId,
          ctx,
        );
        if (live?.runFailure) {
          const reason = live.runFailure.reason;
          if (reason === "turn_limit") {
            await this.wait(
              id,
              "budget",
              "ツール実行またはモデル呼び出しの上限に達しました",
            );
            return;
          }
          if (reason === "model_error" || reason === "no_model") {
            await this.wait(
              id,
              "network",
              "モデル接続を確認して再開してください。自動再試行は上限付きです",
            );
            return;
          }
          await this.update(id, (current) => {
            if (current.status === "running") {
              current.status = "failed";
              current.detail = `推論を終了しました: ${reason}`;
            }
          });
        } else {
          const missing = await this.completionProblems(job);
          let decided = false;
          await this.update(id, (current) => {
            // The artifact reads above can yield to a pause, cancel or new input. Decide only against this exact revision.
            if (
              current.status !== "running" ||
              current.revision !== job.revision
            )
              return;
            if (current.deadlineAt! <= this.now()) {
              current.status = "waiting";
              current.waitReason = "budget";
              current.detail = "仕事の期限に達しました";
            } else {
              current.status = missing.length ? "failed" : "succeeded";
              current.detail = missing.length
                ? missing.join("、")
                : current.completion!.summary;
            }
            decided = true;
          });
          if (!decided) continue;
        }
        await this.stop(id);
        return;
      }
    } finally {
      clearTimeout(deadline);
    }
  }

  private async refreshInputs(id: string): Promise<void> {
    const job = await this.job(id),
      applied: string[] = [];
    for (const input of job.inputs) {
      if (!input.submissionId || input.applied) continue;
      const submission = await this.harness.submission(input.submissionId, ctx),
        state = await submission?.status(ctx);
      if (state && state.entry !== undefined) applied.push(input.requestId);
    }
    if (applied.length)
      await this.update(id, (current) => {
        for (const input of current.inputs)
          if (applied.includes(input.requestId)) input.applied = true;
      });
  }
  private async reserve(
    sessionId: string | undefined,
    modelId: string,
  ): Promise<void> {
    this.assertHealthy();
    let refused = true;
    await this.harness.commit(async (tx) => {
      const app = await tx.doc(AppDoc),
        job = app.activeJobId ? this.find(app, app.activeJobId) : undefined;
      if (
        !job ||
        job.status !== "running" ||
        app.recoveryHold ||
        job.recoveryRequired ||
        this.stopping ||
        unresolved(job).length ||
        modelId !== job.modelId
      )
        return;
      const provider = await tx.doc(ProviderDoc, job.conversationId);
      if (!sessionId || provider.sessionId !== sessionId) return;
      if (
        job.counters.modelRequests >= job.limits.modelRequests ||
        job.deadlineAt! <= this.now()
      ) {
        job.status = "waiting";
        job.waitReason = "budget";
        job.detail = "回数または期限の上限に達しました";
        touch(job);
        return;
      }
      job.counters.modelRequests++;
      touch(job);
      refused = false;
    }, ctx);
    this.notify();
    if (refused) throw new AppError(409, "モデル呼び出しを停止しました");
  }
  private providerError(
    message: string,
    sessionId: string | undefined,
    modelId: string,
  ): void {
    const reason: WaitReason =
      /401|403|unauthori|api.?key|authentication/i.test(message)
        ? "credentials"
        : "network";
    void this.snapshot()
      .then(async (app) => {
        const job = app.jobs.find((job) => job.id === app.activeJobId);
        if (
          job?.status === "running" &&
          job.modelId === modelId &&
          (await this.harness.snapshot(ProviderDoc, job.conversationId, ctx))
            ?.sessionId === sessionId &&
          reason === "credentials"
        )
          return this.wait(
            job.id,
            reason,
            "モデルの認証情報を確認してください",
          );
      })
      .catch(() => undefined);
  }
  async toolJob(api: ToolExecutionApi): Promise<Job> {
    const app = await this.snapshot(),
      job = app.jobs.find(
        (job) =>
          job.id === app.activeJobId &&
          job.conversationId === api.conversationId,
      );
    if (
      !job ||
      job.status !== "running" ||
      app.recoveryHold ||
      job.recoveryRequired ||
      this.stopping ||
      unresolved(job).length ||
      job.deadlineAt! <= this.now()
    )
      throw new AppError(403, "この仕事の処理は停止されています");
    return structuredClone(job);
  }
  async worker(
    job: Job,
    op: WorkerRequest["op"],
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    const current = await this.job(job.id);
    if (current.status !== "running" || this.stopping || signal?.aborted)
      throw new AppError(409, "停止した仕事は実行できません");
    return this.runner.call(job.id, op, args, signal);
  }
  async changed(id: string): Promise<void> {
    await this.update(id, (job) => {
      job.workspaceRevision++;
      delete job.completion;
    });
  }
  async prepare(
    id: string,
    kind: Operation["kind"],
    target: string,
    args: unknown,
    payload?: GithubPayload,
  ): Promise<Operation> {
    const operation: Operation = {
      id: randomUUID(),
      jobId: id,
      kind,
      target,
      argumentHash: hash(args),
      policyRevision: (await this.job(id)).policyRevision,
      status: "prepared",
      ...(payload ? { payload } : {}),
    };
    await this.update(id, (job) => {
      if (
        unresolved(job).length ||
        job.recoveryRequired ||
        job.operations.some(
          (operation) =>
            operation.kind === "github" && operation.status === "prepared",
        )
      )
        throw new AppError(409, "未知操作を先に照合してください");
      job.operations.push(operation);
    });
    return operation;
  }
  async dispatch(id: string, operationId: string): Promise<void> {
    await this.update(id, (job) => {
      const operation = job.operations.find((op) => op.id === operationId)!;
      if (
        operation.status !== "prepared" ||
        (operation.kind === "shell" && job.status !== "running") ||
        unresolved(job).length ||
        job.recoveryRequired ||
        terminal(job)
      )
        throw new AppError(409, "この操作は送信できません");
      if (operation.kind === "github") {
        const approval = job.approvals.find(
          (item) => item.id === operation.approvalId,
        );
        if (
          !job.externalAllowed ||
          !job.allowedRepositories.includes(operation.target) ||
          operation.payload?.repository !== operation.target ||
          !approval?.approved ||
          approval.argumentHash !== operation.argumentHash ||
          approval.policyRevision !== job.policyRevision ||
          hash(operation.payload) !== operation.argumentHash
        )
          throw new AppError(403, "操作内容に結び付いた承認が必要です");
      }
      operation.status = "dispatched";
    });
  }
  async unknown(id: string, operationId: string): Promise<void> {
    await this.update(id, (job) => {
      job.operations.find((op) => op.id === operationId)!.status = "unknown";
      if (!terminal(job)) {
        job.status = "waiting";
        job.waitReason = "reconciliation";
      }
      job.detail = "操作結果が不明です。再送せず照合してください";
    });
  }
  async shell(
    job: Job,
    command: string,
    validation: boolean,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    await this.changed(job.id);
    const op = await this.prepare(job.id, "shell", "workspace", { command });
    await this.dispatch(job.id, op.id);
    try {
      const result = await this.worker(
        await this.job(job.id),
        "shell",
        {
          command,
          timeout: job.limits.commandSeconds,
          maxBytes: job.limits.logBytes,
        },
        signal,
      );
      if (
        signal?.aborted ||
        result.exitCode === 124 ||
        result.cleanup === false
      ) {
        await this.unknown(job.id, op.id);
        return result;
      }
      await this.update(job.id, (current) => {
        current.operations.find((item) => item.id === op.id)!.status =
          "completed";
      });
      const current = await this.job(job.id);
      if (result.log) {
        const artifact = await this.publish(
          current,
          result.log,
          `command-${op.id}.log`,
          "text/plain",
        );
        if (validation)
          await this.update(job.id, (current) => {
            current.validations.push({
              id: randomUUID(),
              kind: "command",
              command,
              exitCode: result.exitCode ?? 128,
              logArtifactId: artifact.id,
              workspaceRevision: current.workspaceRevision,
              createdAt: new Date().toISOString(),
            });
          });
      }
      return result;
    } catch {
      await this.unknown(job.id, op.id);
      throw new AppError(409, "Shell の結果が不明です。照合してください");
    }
  }
  async publish(
    job: Job,
    path: string,
    name: string,
    mediaType: string,
  ): Promise<Artifact> {
    safeRelative(path);
    const result = await this.runner.call(job.id, "export", { path });
    if (result.data === undefined)
      throw new AppError(503, "成果物を読み出せません");
    const bytes = Buffer.from(result.data, "base64");
    return this.save(job.id, name, mediaType, bytes);
  }
  private async save(
    id: string,
    name: string,
    mediaType: string,
    bytes: Buffer,
  ): Promise<Artifact> {
    const job = await this.job(id);
    if (
      bytes.length > job.limits.artifactBytes ||
      job.artifacts.reduce((sum, item) => sum + item.size, bytes.length) >
        job.limits.artifactTotalBytes
    )
      throw new AppError(413, "成果物の保存上限を超えています");
    for (const secret of this.secrets)
      if (secret && bytes.includes(Buffer.from(secret)))
        throw new AppError(403, "制御用の秘密情報を成果物に保存できません");
    const version =
      job.artifacts.filter((item) => item.name === name).length + 1;
    const artifact = await this.artifacts.save(
      id,
      name,
      mediaType,
      bytes,
      version,
      job.workspaceRevision,
    );
    await this.update(id, (current) => {
      current.artifacts.push(artifact);
    });
    return artifact;
  }
  async source(
    job: Job,
    url: string,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    const result = await this.worker(job, "source", { url }, signal);
    if (!result.url || !result.title || !result.text || !result.fetchedAt)
      throw new AppError(503, "資料の取得を確認できません");
    const artifact = await this.save(
      job.id,
      `source-${randomUUID()}.txt`,
      "text/plain",
      Buffer.from(result.text),
    );
    await this.update(job.id, (current) => {
      current.sources.push({
        id: randomUUID(),
        url: result.url!,
        title: result.title!,
        fetchedAt: result.fetchedAt!,
        quote: result.text!.slice(0, 300),
        truncated: result.truncated ?? false,
        sha256: artifact.sha256,
        artifactId: artifact.id,
      });
    });
    return result;
  }
  async render(
    job: Job,
    source: string,
    output: string,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    await this.changed(job.id);
    const result = await this.worker(
      await this.job(job.id),
      "render",
      { source, output },
      signal,
    );
    const artifact = await this.publish(
      await this.job(job.id),
      output,
      output.split("/").at(-1)!,
      "application/pdf",
    );
    for (const path of result.screenshots ?? []) {
      const image = await this.publish(
        await this.job(job.id),
        path,
        path.split("/").at(-1)!,
        "image/png",
      );
      await this.update(job.id, (current) => {
        current.renderPages.push({
          path,
          artifactId: image.id,
          inspected: false,
          workspaceRevision: current.workspaceRevision,
        });
      });
    }
    const log = await this.save(
      job.id,
      `pdf-inspection-${randomUUID()}.txt`,
      "text/plain",
      Buffer.from(
        JSON.stringify({
          pages: result.pages,
          text: result.text,
          screenshots: result.screenshots,
        }),
      ),
    );
    await this.update(job.id, (current) => {
      current.validations.push({
        id: randomUUID(),
        kind: "render",
        command: `Chromium print; pdfinfo; pdftotext; pdftoppm: ${output}`,
        exitCode: 0,
        logArtifactId: log.id,
        workspaceRevision: current.workspaceRevision,
        createdAt: new Date().toISOString(),
      });
    });
    return {
      ...result,
      text: `${result.text}\nPDF artifact: ${artifact.id}\nInspect EVERY raster page with inspect_image before recording self_review.`,
    };
  }
  async inspectImage(job: Job, path: string): Promise<string> {
    const page = job.renderPages.find(
      (page) =>
        page.path === path && page.workspaceRevision === job.workspaceRevision,
    );
    let bytes: Buffer;
    if (page) {
      bytes = await this.artifacts.read(
        job.artifacts.find((artifact) => artifact.id === page.artifactId)!,
      );
    } else {
      const result = await this.worker(job, "export", { path });
      bytes = Buffer.from(result.data ?? "", "base64");
    }
    if (
      bytes.length > 5 * 1024 * 1024 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new AppError(400, "有限サイズの PNG が必要です");
    if (page)
      await this.update(job.id, (current) => {
        current.renderPages.find(
          (item) =>
            item.path === path &&
            item.workspaceRevision === current.workspaceRevision,
        )!.inspected = true;
      });
    return bytes.toString("base64");
  }
  async browser(
    job: Job,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WorkerResult> {
    await this.changed(job.id);
    const operation = await this.prepare(job.id, "shell", "browser", args);
    await this.dispatch(job.id, operation.id);
    try {
      const result = await this.worker(
        await this.job(job.id),
        "browse",
        args,
        signal,
      );
      if (signal?.aborted) throw new Error("Interrupted browser");
      await this.update(job.id, (current) => {
        current.operations.find((item) => item.id === operation.id)!.status =
          "completed";
      });
      if (result.path)
        await this.publish(
          await this.job(job.id),
          result.path,
          `browser-${operation.id}.png`,
          "image/png",
        );
      return result;
    } catch {
      await this.unknown(job.id, operation.id);
      throw new AppError(409, "ブラウザー操作の結果を確認してください");
    }
  }
  async review(job: Job, text: string): Promise<void> {
    const artifact = await this.save(
      job.id,
      `self-review-${randomUUID()}.md`,
      "text/markdown",
      Buffer.from(text),
    );
    await this.update(job.id, (current) => {
      current.validations.push({
        id: randomUUID(),
        kind: "review",
        command: text,
        exitCode: 0,
        logArtifactId: artifact.id,
        workspaceRevision: current.workspaceRevision,
        createdAt: new Date().toISOString(),
      });
    });
  }
  async proposeCompletion(
    job: Job,
    summary: string,
    limitations: string[],
    criteria: string[],
  ): Promise<string[]> {
    await this.refreshInputs(job.id);
    await this.update(job.id, (current) => {
      current.completion = {
        summary,
        limitations,
        criteria,
        workspaceRevision: current.workspaceRevision,
      };
    });
    const missing = await this.completionProblems(await this.job(job.id));
    if (missing.length)
      await this.update(job.id, (current) => {
        current.counters.repairs++;
        if (current.counters.repairs > current.limits.repairs) {
          current.status = "failed";
          current.detail = missing.join("、");
        }
      });
    return missing;
  }
  private async completionProblems(job: Job): Promise<string[]> {
    const missing: string[] = [];
    if (!job.completion) missing.push("完了提案がありません");
    if (job.completion?.limitations.length) missing.push("未達条件があります");
    if (
      job.completion &&
      job.completion.workspaceRevision !== job.workspaceRevision
    )
      missing.push("完了提案後に作業内容が変更されています");
    if (job.acceptance.some((item) => !job.completion?.criteria.includes(item)))
      missing.push("受入条件の確認が不足しています");
    if (job.inputs.some((input) => !input.applied))
      missing.push("未反映の追加指示があります");
    if (
      unresolved(job).length ||
      job.recoveryRequired ||
      job.operations.some(
        (operation) =>
          operation.kind === "github" && operation.status === "prepared",
      )
    )
      missing.push("未確定の操作があります");
    const validations = job.validations.filter(
      (item) =>
        item.workspaceRevision === job.workspaceRevision && item.exitCode === 0,
    );
    const artifacts = job.artifacts.filter(
      (item) => item.workspaceRevision === job.workspaceRevision,
    );
    if (!validations.some((item) => item.kind === "review"))
      missing.push("現在の版の自己レビューが必要です");
    if (job.kind === "code") {
      if (!validations.some((item) => item.kind === "command"))
        missing.push("現在の版の実コマンド検証が必要です");
      if (
        !artifacts.some((item) => item.name.endsWith(".patch") && item.size > 0)
      )
        missing.push("空でない patch が必要です");
    } else {
      if (job.sources.length < 2) missing.push("複数の取得済み資料が必要です");
      const markdown = artifacts.findLast(
        (item) =>
          item.name.endsWith(".md") && !item.name.startsWith("self-review-"),
      );
      if (
        !markdown ||
        !artifacts.some((item) => item.mediaType === "application/pdf")
      )
        missing.push("Markdown と PDF が必要です");
      if (!validations.some((item) => item.kind === "render"))
        missing.push("PDF の描画検査が必要です");
      const pages = job.renderPages.filter(
        (page) => page.workspaceRevision === job.workspaceRevision,
      );
      if (!pages.length || pages.some((page) => !page.inspected))
        missing.push("PDF の全ページの画像確認が必要です");
      if (markdown) {
        const content = (await this.artifacts.read(markdown)).toString("utf8");
        if (
          job.sources.some(
            (source) =>
              !content.includes(source.url) ||
              !content.includes(source.fetchedAt.slice(0, 10)),
          )
        )
          missing.push("本文に出典 URL と確認日が必要です");
      }
    }
    for (const artifact of artifacts) await this.artifacts.read(artifact);
    return missing;
  }
  async ask(job: Job, reason: string): Promise<void> {
    await this.wait(job.id, "user", reason);
  }
  async proposeGithub(job: Job, payload: GithubPayload): Promise<Operation> {
    if (
      !job.externalAllowed ||
      !this.github ||
      !job.allowedRepositories.includes(payload.repository)
    )
      throw new AppError(
        403,
        "この仕事では GitHub 書き込みが許可・設定されていません",
      );
    this.github.validate(payload, job.id);
    const serialized = JSON.stringify(payload);
    if (this.secrets.some((secret) => secret && serialized.includes(secret)))
      throw new AppError(403, "制御用の秘密情報を GitHub へ送信できません");
    const operation = await this.prepare(
      job.id,
      "github",
      payload.repository,
      payload,
      payload,
    );
    await this.wait(
      job.id,
      "approval",
      "GitHub の変更内容と送信先を確認してください",
    );
    return operation;
  }
  async approve(
    id: string,
    requestId: string,
    revision: number,
    operationId: string,
    approved: boolean,
  ): Promise<{ id: string }> {
    const result = await this.request(
      requestId,
      "approval",
      { id, revision, operationId, approved },
      (app) => {
        const job = this.find(app, id),
          operation = job.operations.find((op) => op.id === operationId);
        if (
          job.revision !== revision ||
          job.status !== "waiting" ||
          !["approval", "user"].includes(job.waitReason ?? "") ||
          job.recoveryRequired ||
          app.recoveryHold ||
          unresolved(job).length > 0 ||
          !operation ||
          operation.status !== "prepared" ||
          operation.policyRevision !== job.policyRevision ||
          !job.externalAllowed ||
          !job.allowedRepositories.includes(operation.target) ||
          !this.github
        )
          throw new AppError(409, "承認対象または状態が更新されています");
        this.github.validate(operation.payload!, job.id);
        const approval = {
          id: randomUUID(),
          operationId,
          argumentHash: operation.argumentHash,
          policyRevision: job.policyRevision,
          approved,
        };
        job.approvals.push(approval);
        operation.approvalId = approval.id;
        if (!approved) {
          operation.status = "failed";
          job.waitReason = "user";
          job.detail = "外部変更を拒否しました";
        }
        touch(job);
        return { id: operation.id };
      },
    );
    if (approved && !this.externalRuns.has(operationId)) {
      const running = this.executeGithub(id, operationId)
        .catch(() => {
          if (this.healthy()) {
            this.fatal = true;
            this.notify();
          }
        })
        .finally(() => this.externalRuns.delete(operationId));
      this.externalRuns.set(operationId, running);
    }
    return result;
  }
  private async executeGithub(id: string, operationId: string): Promise<void> {
    const job = await this.job(id),
      operation = job.operations.find((op) => op.id === operationId)!;
    // A repeated HTTP receipt must not schedule an already sent operation again.
    if (operation.status !== "prepared") return;
    try {
      await this.dispatch(id, operationId);
    } catch (error) {
      if (error instanceof AppError && [403, 409].includes(error.statusCode))
        return;
      throw error;
    }
    try {
      const resultId = await this.github!.execute(operation);
      await this.update(id, (job) => {
        const current = job.operations.find((op) => op.id === operationId)!;
        current.status = "completed";
        current.resultId = resultId;
        job.waitReason = "user";
        job.detail = `下書き PR #${resultId} を作成しました。確認して再開してください`;
      });
    } catch {
      await this.unknown(id, operationId);
    }
  }
  async reconcile(
    id: string,
    requestId: string,
    revision: number,
    operationId: string,
    resolution:
      | "check_github"
      | "completed"
      | "not_executed"
      | "acknowledge_recovery",
    evidence: string,
  ): Promise<{ id: string }> {
    const previous = (await this.snapshot()).receipts[requestId];
    if (previous) {
      if (
        previous.hash !==
        hash({
          kind: "reconciliation",
          payload: { id, revision, operationId, resolution, evidence },
        })
      )
        throw new AppError(409, "同じ requestId の内容が一致しません");
      return { id: previous.result.id };
    }
    let externalResult: string | null = null;
    if (resolution === "check_github") {
      const job = await this.job(id),
        operation = job.operations.find((op) => op.id === operationId);
      if (
        !operation ||
        operation.status !== "unknown" ||
        operation.kind !== "github" ||
        !this.github
      )
        throw new AppError(409, "照合できる GitHub 操作がありません");
      externalResult = await this.github.reconcile(operation);
      if (!externalResult)
        throw new AppError(
          409,
          "既存 PR を一意に確認できません。外部の状態を手動で確認してください",
        );
    }
    const result = await this.request(
      requestId,
      "reconciliation",
      { id, revision, operationId, resolution, evidence },
      (app) => {
        const job = this.find(app, id);
        if (job.revision !== revision)
          throw new AppError(409, "最新状態を確認してください");
        if (resolution === "acknowledge_recovery") {
          job.recoveryRequired = false;
          app.recoveryHold = false;
        } else {
          const operation = job.operations.find((op) => op.id === operationId);
          if (!operation || operation.status !== "unknown")
            throw new AppError(409, "未知操作がありません");
          operation.status =
            resolution === "not_executed" ? "failed" : "completed";
          operation.evidence = evidence;
          if (externalResult) operation.resultId = externalResult;
        }
        if (
          !terminal(job) &&
          !unresolved(job).length &&
          !job.recoveryRequired
        ) {
          job.status = "waiting";
          job.waitReason = "user";
          job.detail = "照合を記録しました。作業環境を確認して再開してください";
        }
        touch(job);
        return { id };
      },
    );
    if (terminal(await this.job(id)))
      void this.stop(id).catch(() => {
        this.fatal = true;
      });
    return result;
  }
  async upload(
    requestId: string,
    name: string,
    bytes: Buffer,
  ): Promise<{ id: string }> {
    if (bytes.length > this.config.limits.uploadBytes)
      throw new AppError(413, "添付の上限を超えています");
    const fingerprint = hash({ name, sha256: byteHash(bytes) });
    const previous = (await this.snapshot()).receipts[requestId];
    if (previous) {
      if (previous.hash !== hash({ kind: "upload", payload: fingerprint }))
        throw new AppError(409, "同じ requestId の内容が一致しません");
      return previous.result;
    }
    const artifact = await this.uploads.save(
      "upload",
      name,
      "application/octet-stream",
      bytes,
      1,
      0,
    );
    return this.request(requestId, "upload", fingerprint, (app) => {
      if (
        app.uploads.reduce((sum, item) => sum + item.size, bytes.length) >
        1024 * 1024 * 1024
      )
        throw new AppError(507, "添付の保存上限に達しました");
      app.uploads.push({
        id: artifact.id,
        name,
        size: artifact.size,
        sha256: artifact.sha256,
      });
      return { id: artifact.id };
    });
  }
  async settings(
    requestId: string,
    revision: number,
    commonInstructions: string,
    projectNotes: Record<string, string>,
  ): Promise<{ id: string }> {
    return this.request(
      requestId,
      "settings",
      { revision, commonInstructions, projectNotes },
      (app) => {
        if (app.settings.revision !== revision)
          throw new AppError(409, "設定が更新されています");
        app.settings = {
          revision: revision + 1,
          commonInstructions,
          projectNotes,
        };
        return { id: String(revision + 1) };
      },
    );
  }
  async view(id: string, cursor?: Cursor): Promise<unknown> {
    const job = await this.job(id),
      conversation = (await this.harness.conversation(
        job.conversationId,
        ctx,
      ))!;
    const entries = await conversation.entries(
      { order: "descending" },
      40,
      cursor,
      ctx,
    );
    const transcript = entries.items.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      messages: (entry.model ?? [])
        .map((message) => ({
          role: message.role,
          toolName:
            message.role === "toolResult"
              ? message.toolName
              : typeof message.content === "string"
                ? undefined
                : message.content.find((block) => block.type === "toolCall")
                    ?.name,
          content:
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter(
                    (block) =>
                      block.type === "text" || block.type === "toolCall",
                  )
                  .map((block) =>
                    block.type === "text"
                      ? block.text
                      : `${block.name} ${JSON.stringify(block.arguments).slice(0, 2000)}`,
                  )
                  .join("\n"),
        }))
        .map((message) => ({
          ...message,
          content: message.content.slice(-12000),
        })),
    }));
    const usage = await this.harness.snapshot(
      UsageDoc,
      job.conversationId,
      ctx,
    );
    const live = await this.harness.snapshot(LiveDoc, job.conversationId, ctx);
    return {
      job,
      transcript,
      cursor: entries.next,
      progress: {
        generating: !!live?.generation,
        tools:
          live?.tools?.map((tool) => ({
            name: tool.name,
            status: tool.status,
            output: tool.output?.slice(-2000),
          })) ?? [],
      },
      usage: { reported: usage ?? null, unknown: true },
      modelConfigured: this.providerReady,
      healthy: this.healthy(),
    };
  }
  async close(): Promise<void> {
    const canMarkClean = !this.fatal && this.externalRuns.size === 0;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.notify();
    await this.harness.close(ctx);
    await this.runner.close();
    if (!canMarkClean) return;
    // A clean marker is set only by the service shutdown path after task and worker teardown.
    // Harness.close seals commits, so reopen without scheduling to persist the marker.
    const storage = await openNodeSqliteStorage(
      join(this.config.dataRoot, "control/state.sqlite"),
    );
    const final = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      ctx,
    );
    await final.commit(async (tx) => {
      (await tx.doc(AppDoc)).cleanShutdown = true;
    }, ctx);
    await final.close(ctx);
  }
}
