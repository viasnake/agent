import { EventEmitter } from "node:events";
import { realpath, readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import lockfile from "proper-lockfile";
import { applyRun } from "./artifacts.js";
import {
  configHash,
  loadConfig,
  validateConfig,
  type Config,
  type Paths,
} from "./config.js";
import {
  Conversations,
  type Conversation,
  type PendingInput,
} from "./conversations.js";
import { Harness } from "./harness.js";
import { Sandbox } from "./sandbox.js";
import { Store } from "./storage.js";
import {
  AgentError,
  terminalStates,
  type Run,
  type Runtime,
  type WorkKind,
} from "./types.js";
import {
  atomicWrite,
  canonical,
  errorMessage,
  id,
  readText,
  safePath,
  sha256,
} from "./util.js";
import { secretPath, workspaceDiff } from "./workspace.js";

export interface AppEvent {
  type: string;
  sessionId: string;
  runId?: string;
  detail: Record<string, unknown>;
}
export function inferKind(text: string, previous?: WorkKind): WorkKind {
  if (/\b(research|sources|citations)\b|調査|出典|根拠付き/i.test(text))
    return "research";
  if (
    /\b(write|draft|translate|rewrite)\b.*\b(document|article|email|markdown|prose)\b|文書|記事|整文|翻訳|案内文|文章.*(作成|直|書)/i.test(
      text,
    )
  )
    return "writing";
  if (
    /\b(fix|implement|refactor|bug|add|remove|change|test)\b|修正|実装|改善|バグ|リファクタ|追加|削除|変更|テスト/i.test(
      text,
    )
  )
    return "coding";
  if (
    /^(次に|続け|それ|これも|also\b|next\b|continue\b)/i.test(text) &&
    previous
  )
    return previous;
  return "chat";
}
export function fileReferences(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/(?:^|\s)@(?:"([^"\n]+)"|([^\s]+))/g)].map(
        (m) => m[1] ?? m[2]!,
      ),
    ),
  ];
}

export class Application extends EventEmitter {
  readonly conversations: Conversations;
  session!: Conversation;
  busy = false;
  activeRunId?: string;
  private controller?: AbortController;
  private work?: Promise<void>;
  private generation = 0;
  private heartbeat?: NodeJS.Timeout;
  private closed = false;
  constructor(
    public config: Config,
    readonly paths: Paths,
    readonly store: Store,
    readonly workspace: string,
    readonly runtimeFactory: (config: Config) => Promise<Runtime> = async (
      config,
    ) => {
      const { PiRuntime } = await import("./runtime/pi.js");
      return new PiRuntime(config, paths);
    },
  ) {
    super();
    this.conversations = new Conversations(store);
  }
  async initialize(): Promise<void> {
    this.session = this.conversations.create(await realpath(this.workspace), {
      dataClass: this.config.defaults.dataClass,
      strategy: this.config.defaults.mode,
      checks: Object.keys(this.config.checks),
    });
    this.heartbeat = setInterval(() => {
      try {
        this.conversations.save(this.session);
      } catch (error) {
        this.stop();
        this.publish("notice", { text: errorMessage(error) });
      }
    }, 3000);
    this.heartbeat.unref();
    this.publish("changed");
  }
  private publish(
    type: string,
    detail: Record<string, unknown> = {},
    runId = this.activeRunId,
  ): void {
    this.emit("event", {
      type,
      detail,
      runId,
      sessionId: this.session.id,
    } satisfies AppEvent);
  }
  private idle(): void {
    if (this.busy)
      throw new AgentError(
        "BUSY",
        "実行中です。停止または完了後に操作してください。",
      );
  }
  save(): void {
    this.conversations.save(this.session);
    this.publish("changed");
  }
  setDraft(text: string): void {
    if (Buffer.byteLength(text) > this.config.limits.maxInputBytes) return;
    this.session.draft = text;
    this.conversations.save(this.session);
  }
  async newSession(): Promise<void> {
    this.idle();
    this.conversations.release(this.session.id);
    ++this.generation;
    this.session = this.conversations.create(this.session.workspace, {
      dataClass: this.config.defaults.dataClass,
      strategy: this.config.defaults.mode,
      checks: Object.keys(this.config.checks),
    });
    this.publish("session");
  }
  openSession(sessionId: string): void {
    this.idle();
    if (this.conversations.get(sessionId).workspace !== this.session.workspace)
      throw new AgentError(
        "SESSION",
        "現在の作業ディレクトリの会話を選択してください。",
      );
    const next = this.conversations.acquire(sessionId);
    this.conversations.release(
      this.session.id === sessionId ? "" : this.session.id,
    );
    this.session = next;
    ++this.generation;
    this.publish("session");
  }
  async attachments(text: string): Promise<{ path: string; bytes: number }[]> {
    let total = Buffer.byteLength(text);
    const refs = [];
    for (const path of fileReferences(text)) {
      if (secretPath(path))
        throw new AgentError(
          "PATH_DENIED",
          "認証・制御ファイルは添付できません。",
        );
      const content = await readText(
        await safePath(this.session.workspace, path),
        this.config.limits.maxFileBytes,
      );
      total += Buffer.byteLength(content);
      refs.push({ path, bytes: Buffer.byteLength(content) });
    }
    if (total > this.config.limits.maxInputBytes)
      throw new AgentError(
        "INPUT_SIZE",
        "依頼と添付ファイルが入力上限を超えています。",
      );
    return refs;
  }
  async submit(
    text: string,
    mode: PendingInput["mode"] = "instruction",
  ): Promise<void> {
    if (!text.trim()) return;
    await this.attachments(text);
    if (this.busy && mode === "instruction" && fileReferences(text).length)
      throw new AgentError(
        "INPUT",
        "実行中に新しいファイルを添付する場合は Alt+Enter または /next で次の依頼にしてください。現在のコピー内のパスは @ を付けずに参照できます。",
      );
    if (this.session.queue.length >= 30)
      throw new AgentError("QUEUE", "待機入力は30件までです。");
    const item: PendingInput = {
      id: id(),
      text,
      mode: this.busy ? mode : "next",
      runId: this.busy && mode === "instruction" ? this.activeRunId : undefined,
    };
    if (!this.session.latestRunId && this.session.name === "新しい会話")
      this.session.name = text.split("\n")[0]!;
    this.session.queue.push(item);
    this.session.draft = "";
    this.save();
    if (this.busy)
      this.publish("notice", {
        text:
          mode === "instruction"
            ? "追加指示を受付。次の Task 境界で要件と検証を更新します。"
            : "完了後の依頼として保存しました。",
      });
    else this.startQueue();
  }
  editQueued(inputId: string, text: string): void {
    if (Buffer.byteLength(text) > this.config.limits.maxInputBytes)
      throw new AgentError("INPUT_SIZE", "入力上限を超えています。");
    const item = this.session.queue.find((q) => q.id === inputId);
    if (!item)
      throw new AgentError("QUEUE", "この入力は既に処理されています。");
    item.text = text;
    this.save();
  }
  cancelQueued(inputId: string): void {
    this.session.queue = this.session.queue.filter((q) => q.id !== inputId);
    this.save();
  }
  startQueue(): void {
    if (this.busy || this.closed) return;
    const next = this.session.queue.find((q) => q.mode === "next");
    if (!next) return;
    this.busy = true;
    this.controller = new AbortController();
    const generation = this.generation;
    let succeeded = false;
    this.work = this.execute(next, generation)
      .then(() => {
        succeeded = this.currentRun()?.state === "succeeded";
      })
      .catch((error) => {
        this.publish("notice", { text: errorMessage(error) });
      })
      .finally(() => {
        this.busy = false;
        this.activeRunId = undefined;
        this.publish("changed");
      });
    void this.work.then(() => {
      const latest =
        this.session.latestRunId && this.store.get(this.session.latestRunId);
      if (
        succeeded &&
        !this.controller?.signal.aborted &&
        latest &&
        latest.state === "succeeded" &&
        !this.session.queue.some((q) => q.mode === "instruction")
      )
        this.startQueue();
    });
  }
  async waitForIdle(): Promise<void> {
    while (this.busy) await this.work;
  }
  stop(): void {
    this.controller?.abort();
    this.publish("notice", {
      text: "中断を要求しました。未確定操作と待機入力は保存します。",
    });
  }
  private async execute(
    input: PendingInput,
    generation: number,
  ): Promise<void> {
    const signal = this.controller!.signal;
    const previous = this.session.latestRunId
      ? this.store.get(this.session.latestRunId)
      : undefined;
    const kind =
      this.session.kind === "auto"
        ? inferKind(input.text, previous?.kind)
        : this.session.kind;
    const refs = await this.attachments(input.text);
    const config = structuredClone(this.config);
    if (
      previous &&
      (["public", "private", "restricted"].indexOf(this.session.dataClass) <
        ["public", "private", "restricted"].indexOf(previous.dataClass) ||
        (previous.localOnly && !this.session.localOnly))
    )
      throw new AgentError(
        "DISCLOSURE_DENIED",
        "既存会話の送信範囲を広げるには新しい会話を使ってください。",
      );
    const runtime = await this.runtimeFactory(config);
    signal.throwIfAborted();
    const harness = new Harness(
      config,
      this.paths,
      this.store,
      runtime,
      (type, detail) => {
        if (
          generation === this.generation &&
          (!detail.runId || detail.runId === this.activeRunId)
        )
          this.publish(
            type,
            detail,
            typeof detail.runId === "string" ? detail.runId : this.activeRunId,
          );
      },
    );
    const contextRun = this.session.contextRunId
      ? this.store.get(this.session.contextRunId)
      : undefined;
    const previousSessions: NonNullable<Run["previousSessions"]> = {};
    if (!this.session.compacted && contextRun?.kind === kind)
      for (const task of contextRun.tasks)
        if (task.sessionFile && task.model)
          previousSessions[task.id] = {
            model: task.model,
            file: task.sessionFile,
          };
    const parentRunId =
      kind === "coding"
        ? this.session.workRunId
        : kind === "writing" || kind === "research"
          ? this.session.documentRunId
          : undefined;
    const usableParent =
      parentRunId &&
      (this.store.get(parentRunId).kind === kind ||
        ["writing", "research"].includes(kind))
        ? parentRunId
        : undefined;
    // A context handoff carries verified status and references; Pi alone owns model turns.
    const context =
      this.session.handoff ??
      (contextRun
        ? canonical({
            objective: contextRun.objective,
            state: contextRun.state,
            reason: contextRun.reason,
            tasks: contextRun.tasks.map((t) => ({
              role: t.role,
              model: t.model,
              result: t.result,
            })),
            artifacts: this.store
              .artifacts(contextRun.id)
              .map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
          })
        : undefined);
    const run = await harness.create({
      extraPaths:
        kind === "coding" && this.session.appliedRunId
          ? Object.keys(
              JSON.parse(
                await readFile(
                  join(
                    this.store.runDir(this.session.appliedRunId),
                    "validated-manifest.json",
                  ),
                  "utf8",
                ),
              ),
            )
          : undefined,
      objective: input.text,
      kind,
      mode: kind === "chat" ? "single" : this.session.strategy,
      dataClass: this.session.dataClass,
      localOnly: this.session.localOnly,
      workspace: kind === "coding" ? this.session.workspace : undefined,
      parentRunId: usableParent,
      previousSessions,
      context,
      includeUntracked: this.session.includeUntracked,
      model: this.session.model,
      reviewer: this.session.reviewer,
      inputs: refs.map((r) => join(this.session.workspace, r.path)),
      checks: kind === "coding" ? this.session.checks : [],
    });
    this.activeRunId = run.id;
    this.store.transaction(() => {
      this.conversations.link(this.session, run);
      this.session.latestRunId = run.id;
      if (kind === "coding") this.session.workRunId = run.id;
      if (kind === "writing" || kind === "research")
        this.session.documentRunId = run.id;
      this.session.queue = this.session.queue.filter((q) => q.id !== input.id);
      this.conversations.message(this.session, "user", input.text, run.id);
      this.conversations.save(this.session);
    });
    this.publish("run_started", { kind, mode: run.mode });
    await this.executePrepared(harness, run, signal);
  }
  private async executePrepared(
    harness: Harness,
    run: Run,
    signal: AbortSignal,
  ): Promise<void> {
    let instructions: PendingInput[] = [];
    const result = await harness.execute(
      run.id,
      signal,
      undefined,
      () => {
        instructions = this.session.queue.filter(
          (q) => q.mode === "instruction" && (!q.runId || q.runId === run.id),
        );
        return instructions.map((q) => q.text);
      },
      () => {
        for (const item of instructions)
          this.conversations.message(this.session, "user", item.text, run.id);
        this.session.queue = this.session.queue.filter(
          (q) => !instructions.some((i) => i.id === q.id),
        );
        this.conversations.save(this.session);
      },
    );
    this.session.contextRunId = result.id;
    this.session.compacted = false;
    this.session.handoff = undefined;
    const summary =
      result.state === "succeeded"
        ? result.tasks
            .map((t) => t.result?.summary)
            .filter(Boolean)
            .join("\n\n")
        : `${result.state}: ${result.reason ?? "未完了"}`;
    this.conversations.message(this.session, "assistant", summary, result.id);
    this.save();
    this.publish("run_finished", { run: result });
  }
  async resume(): Promise<void> {
    this.idle();
    const run = this.currentRun();
    if (!run || terminalStates.includes(run.state))
      throw new AgentError(
        "TERMINAL_RUN",
        "完了・失敗・中断した作業は再実行しません。続きの依頼を入力してください。",
      );
    if (run.configHash !== configHash(this.config))
      throw new AgentError(
        "POLICY_CHANGED",
        "設定が変わっています。新しい依頼として続けてください。",
      );
    this.busy = true;
    this.activeRunId = run.id;
    this.controller = new AbortController();
    const signal = this.controller.signal,
      generation = this.generation;
    this.publish("run_started", { kind: run.kind, mode: run.mode });
    this.work = (async () => {
      const runtime = await this.runtimeFactory(this.config);
      const harness = new Harness(
        this.config,
        this.paths,
        this.store,
        runtime,
        (type, detail) => {
          if (
            generation === this.generation &&
            (!detail.runId || detail.runId === this.activeRunId)
          )
            this.publish(type, detail, run.id);
        },
      );
      await this.executePrepared(harness, run, signal);
    })().finally(() => {
      this.busy = false;
      this.activeRunId = undefined;
      this.publish("changed");
    });
    await this.work;
  }
  async diff(): Promise<{
    runId: string;
    patch: string;
    files: string[];
    applicable: boolean;
    reason?: string;
    token: string;
  }> {
    this.idle();
    const runId = this.session.workRunId;
    const sessionId = this.session.id;
    if (!runId)
      throw new AgentError("DIFF", "未適用のコード変更はありません。");
    const delta = await workspaceDiff(
      this.store.runDir(runId),
      this.config.limits.maxWorkspaceBytes,
    );
    let applicable = false,
      reason: string | undefined;
    try {
      const result = await applyRun(this.config, this.store, runId, true);
      applicable = "applicable" in result && result.applicable === true;
    } catch (error) {
      reason = errorMessage(error);
    }
    this.idle();
    if (this.session.id !== sessionId || this.session.workRunId !== runId)
      throw new AgentError(
        "STALE_VIEW",
        "作業が切り替わりました。差分を開き直してください。",
      );
    return {
      runId,
      patch: delta.patch,
      files: delta.changes.map((c) => c.path),
      applicable,
      reason,
      token: sha256(
        canonical({
          session: this.session.id,
          runId,
          patch: delta.patch,
          config: configHash(this.config),
        }),
      ),
    };
  }
  async apply(token: string): Promise<void> {
    this.idle();
    const current = await this.diff();
    this.idle();
    if (current.runId !== this.session.workRunId)
      throw new AgentError(
        "STALE_VIEW",
        "作業が切り替わりました。差分を開き直してください。",
      );
    if (!current.applicable || current.token !== token)
      throw new AgentError(
        "APPLY",
        "差分または適用条件が変わりました。/diff で確認してください。",
      );
    this.busy = true;
    this.controller = new AbortController();
    this.work = (async () => {
      const result = await applyRun(
        this.config,
        this.store,
        current.runId,
        false,
        this.controller!.signal,
      );
      this.session.appliedRunId = current.runId;
      this.session.workRunId = undefined;
      this.conversations.message(
        this.session,
        "system",
        `適用完了: ${current.files.join(", ")}`,
        current.runId,
      );
      this.save();
      this.publish("applied", { result });
    })().finally(() => {
      this.busy = false;
      this.publish("changed");
    });
    await this.work;
  }
  async reconcile(
    operationId: string,
    outcome: "completed" | "failed",
    note: string,
  ): Promise<void> {
    this.idle();
    if (!note.trim())
      throw new AgentError("OPERATION", "照合した内容を入力してください。");
    const runId = this.session.latestRunId;
    if (!runId) return;
    const run = this.store.claim(runId, true, true);
    try {
      this.store.reconcile(run, operationId, outcome, note);
    } finally {
      this.store.release(run);
    }
    this.publish("changed");
  }
  async compact(): Promise<void> {
    this.idle();
    const runId = this.session.contextRunId;
    if (!runId) return;
    const run = this.store.get(runId);
    const handoff = canonical({
      objective: run.objective,
      state: run.state,
      reason: run.reason,
      results: run.tasks.map((t) => ({
        model: t.model,
        summary: t.result?.summary,
        unresolved: t.result?.unresolved,
      })),
      artifacts: this.store.artifacts(runId).map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        sha256: a.sha256,
      })),
      workingCopy: this.session.workRunId,
      checks: run.checks,
    });
    await atomicWrite(join(this.store.runDir(runId), "handoff.json"), handoff);
    this.session.compacted = true;
    this.session.handoff = handoff;
    this.save();
    this.publish("notice", {
      text: "引き継ぎ情報を保存しました。次の依頼から新しい Pi セッションを使います。原文・出典・検証記録は保持しています。",
    });
  }
  async saveConfiguration(input: unknown): Promise<void> {
    const next = validateConfig(input);
    const release = await lockfile.lock(this.paths.config, {
      stale: 30000,
      retries: 0,
    });
    try {
      const current = await loadConfig(this.paths);
      if (configHash(current) !== configHash(this.config))
        throw new AgentError(
          "CONFIG_CHANGED",
          "設定が外部で変更されました。再起動してから編集してください。",
        );
      await atomicWrite(
        `${this.paths.config}.bak`,
        await readFile(this.paths.config),
      );
      await atomicWrite(this.paths.config, stringify(next));
      this.config = next;
      this.publish("notice", {
        text: "設定を保存しました。次の依頼から適用します。",
      });
    } finally {
      await release();
    }
  }
  async doctor(): Promise<Record<string, unknown>> {
    const directory = await mkdtemp(join(this.paths.home, "doctor-"));
    try {
      const sandbox =
        this.config.execution.backend === "disabled"
          ? { ok: false, detail: "Shell・コード検査は無効です" }
          : await new Sandbox(this.config.execution).probe(directory);
      return {
        node: process.version,
        platform: process.platform,
        sandbox,
        connections: Object.entries(this.config.connections).map(
          ([name, c]) => ({
            name,
            enabled: c.enabled,
            type: c.type,
            allowedData: c.allowedData,
            credential:
              c.type === "chatgpt"
                ? "ログイン状態は /login で確認"
                : c.type === "local" ||
                    (c.secretEnv && process.env[c.secretEnv])
                  ? "present"
                  : `missing: ${c.secretEnv ?? "secretEnv"}`,
            budget:
              c.billing === "api"
                ? this.config.limits.maxApiUsd > 0 && c.maxRequestUsd > 0
                : "subscription/local",
          }),
        ),
        inference: "未実行。/probe で明示的に実行",
        isolation:
          "ネットワークなし。依存は runtimePaths または固定コンテナへ事前準備",
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    try {
      await this.work?.catch(() => {});
    } finally {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.session) {
        this.conversations.save(this.session);
        this.conversations.release(this.session.id);
      }
    }
  }
  async probe(model: string): Promise<void> {
    this.idle();
    if (!this.config.models[model])
      throw new AgentError("NO_MODEL", "モデルが見つかりません。");
    const config = structuredClone(this.config);
    config.models[model]!.tools = true;
    config.models[model]!.roles = ["worker"];
    config.models[model]!.kinds = ["writing"];
    config.execution.backend = "disabled";
    config.web.allowedHosts = [];
    config.mcp = {};
    config.routing.mode = "rules";
    config.limits.maxRequests = Math.min(config.limits.maxRequests, 6);
    this.busy = true;
    this.controller = new AbortController();
    this.work = (async () => {
      const harness = new Harness(
        config,
        this.paths,
        this.store,
        await this.runtimeFactory(config),
        (type, detail) => this.publish(type, detail),
      );
      const run = await harness.create({
        kind: "writing",
        mode: "single",
        model,
        dataClass: "public",
        objective:
          'Create probe.md containing exactly "Agent connection works." Read it back with read_file. Return it as your artifact.',
        mustKeep: ["Agent connection works."],
      });
      this.activeRunId = run.id;
      this.conversations.link(this.session, run);
      const result = await harness.execute(run.id, this.controller!.signal);
      this.publish("notice", {
        text: `疎通試験: ${result.state} ${result.reason ?? ""}。tools の設定は自動変更していません。`,
      });
    })().finally(() => {
      this.busy = false;
      this.activeRunId = undefined;
      this.publish("changed");
    });
    await this.work;
  }
  currentRun(): Run | undefined {
    return this.session.latestRunId
      ? this.store.get(this.session.latestRunId)
      : undefined;
  }
  async lastValidation(runId = this.session.latestRunId) {
    if (!runId) return undefined;
    // Artifact rows are not ordered. The event sequence identifies the most
    // recently completed validation, including after a repair or restart.
    const saved = this.store.db
      .prepare(
        "SELECT detail FROM events WHERE run_id=? AND type='artifact_saved' AND json_extract(detail,'$.name')='validation.json' AND json_extract(detail,'$.kind')='check' ORDER BY seq DESC LIMIT 1",
      )
      .get(runId) as { detail: string } | undefined;
    if (!saved) return undefined;
    const { artifactId } = JSON.parse(saved.detail) as { artifactId: string };
    return JSON.parse(await this.artifactText(artifactId, runId)) as {
      id: string;
      passed: boolean;
      detail: string;
    }[];
  }
  view(runId = this.session.latestRunId) {
    const run = runId ? this.store.get(runId) : undefined;
    const context =
      run &&
      (this.store.db
        .prepare(
          "SELECT detail FROM events WHERE run_id=? AND type='context_usage' ORDER BY seq DESC LIMIT 1",
        )
        .get(run.id) as { detail: string } | undefined);
    return {
      run,
      context: context
        ? (JSON.parse(context.detail) as {
            bytes: number;
            limit: number;
            model: string;
            taskId: string;
          })
        : undefined,
      usage: run && this.store.usage(run.id),
      artifacts: run ? this.store.artifacts(run.id) : [],
      operations: run ? this.store.operations(run.id) : [],
    };
  }
  artifactRuns(offset = 0): Run[] {
    return (
      this.store.db
        .prepare(
          "SELECT run_id FROM conversation_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 30 OFFSET ?",
        )
        .all(this.session.id, offset) as { run_id: string }[]
    ).map((row) => this.store.get(row.run_id));
  }
  async artifactText(
    artifactId: string,
    runId = this.session.latestRunId,
  ): Promise<string> {
    if (
      !runId ||
      !this.store.db
        .prepare(
          "SELECT 1 FROM conversation_runs WHERE session_id=? AND run_id=?",
        )
        .get(this.session.id, runId)
    )
      throw new AgentError("ARTIFACT", "この会話の作業を選択してください。");
    const artifact = this.view(runId).artifacts.find(
      (a) => a.id === artifactId,
    );
    if (!artifact)
      throw new AgentError("ARTIFACT", "この作業の成果物が見つかりません。");
    return (await this.store.content(artifact)).toString("utf8");
  }
  history(before?: number) {
    return this.conversations.messages(this.session.id, before);
  }
  sessions(offset = 0) {
    return this.conversations.list(this.session.workspace, offset);
  }
  interrupted(): boolean {
    const run = this.currentRun();
    return !!run && !terminalStates.includes(run.state);
  }
}
