import {
  CombinedAutocompleteProvider,
  ProcessTerminal,
  TuiAltScreen,
  Text,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { SettingsDialog } from "./settings.js";
import {
  SettingsEditor,
  type SettingsField,
  type SettingsPosition,
  type SettingsEdit,
} from "./settings-editor.js";
import { Application, fileReferences, type AppEvent } from "../application.js";
import { initialize, loadConfig, paths, type Config } from "../config.js";
import { Store } from "../storage.js";
import type { ConversationMessage } from "../conversations.js";
import { AgentError } from "../types.js";
import { errorMessage, privateDirectory } from "../util.js";
import { interactiveLogin } from "../interactive-services.js";
import { actions, actionFor, commands } from "./actions.js";
import {
  Dialog,
  Reader,
  editor,
  markdown,
  safeText,
  theme,
  Picker,
  WorkbenchLayout,
  terminalTheme,
  ResponsiveOverlay,
} from "./components.js";
import { doctorSummary, failureGuidance, setupSummary } from "./guidance.js";
import {
  ActivityView,
  ConversationView,
  runLabels,
  taskDetails,
  excerpt,
} from "./workbench.js";

export class TerminalApp {
  readonly terminal = new ProcessTerminal();
  readonly tui = new TuiAltScreen(this.terminal, true, undefined, {
    copyOnSelect: false,
    scrollToEndIndicator: () => theme.accent("↓ 最新へ"),
  });
  readonly input = editor(this.tui);
  readonly transcript = new ConversationView();
  readonly progress = new Text("起動中…", 0, 0);
  readonly activity = new ActivityView();
  readonly notification = new Text("", 0, 0);
  readonly inlineDetails = markdown("");
  readonly status = new Text("", 0, 0);
  readonly refs = new Text("", 0, 0);
  readonly layout: WorkbenchLayout;
  app?: Application;
  private reader?: Reader;
  private cancelDialog?: () => void;
  private acceptReader?: () => void;
  private stream = new Map<string, string>();
  private streamBytes = 0;
  private notice = "";
  private closing = false;
  private busyDialog = false;
  private draftTimer?: NodeJS.Timeout;
  private renderTimer?: NodeJS.Timeout;
  private done!: () => void;
  private fail!: (error: unknown) => void;
  private loginAbort?: AbortController;
  private fatal?: unknown;
  private disposeSignals?: () => void;
  private restored = false;
  private earlyExit = false;
  private historySession = "";
  private messages: ConversationMessage[] = [];
  private hasOlder = false;
  private detailKind = "";
  private detailText = "";
  private detailLimit = 24000;
  private detailReturn = { top: 0, following: true };
  constructor(readonly home?: string) {
    this.layout = new WorkbenchLayout(
      [
        this.transcript,
        this.progress,
        this.activity,
        this.inlineDetails,
        this.notification,
      ],
      [this.refs, this.input, this.status],
    );
    this.tui.setLayoutRoot(this.layout);
    this.layout.scroll.onOlder = (remaining) => this.loadOlder(remaining);
    this.tui.setFocus(this.input);
    this.input.setAutocompleteProvider(
      new CombinedAutocompleteProvider(commands, process.cwd(), null),
    );
    this.input.onSubmit = (text) => {
      if (this.draftTimer) clearTimeout(this.draftTimer);
      void this.submit(text).catch((error) => {
        if (!this.input.getExpandedText()) this.input.setText(text);
        this.showError(error);
      });
    };
    this.input.onChange = (text) => {
      this.refs.setText(
        fileReferences(text).length
          ? safeText(`添付候補: ${fileReferences(text).join(", ")}`)
          : "",
      );
      if (this.draftTimer) clearTimeout(this.draftTimer);
      this.draftTimer = setTimeout(() => {
        try {
          const draft = this.input.getExpandedText();
          if (!draft.startsWith("/")) this.app?.setDraft(draft);
        } catch (error) {
          this.showError(error);
        }
      }, 250);
      this.tui.requestRender();
    };
    this.tui.addInputListener((data) => this.key(data));
  }
  private key(data: string): { consume: boolean } | undefined {
    // Consume LF before Pi can interpret Ctrl+J as newline or dialog confirmation.
    if (matchesKey(data, "ctrl+j")) return { consume: true };
    const action = actionFor(data);
    if (this.tui.hasOverlay()) {
      if (this.reader && this.acceptReader && matchesKey(data, "enter")) {
        this.acceptReader();
        return { consume: true };
      }
      if (this.reader && action === "tools") {
        this.cancelDialog?.();
        return { consume: true };
      }
      if (
        this.reader &&
        (matchesKey(data, "left") || matchesKey(data, "right"))
      ) {
        this.reader.turnPage(matchesKey(data, "left") ? -1 : 1);
        return { consume: true };
      }
      if (action === "cancel" || action === "interrupt") {
        this.cancelDialog?.();
        return { consume: true };
      }
      if (this.reader && (action === "up" || action === "down")) {
        this.reader.scroll.scrollBy(
          (action === "up" ? -1 : 1) * Math.max(1, this.terminal.rows - 6),
        );
        this.tui.requestRender();
        return { consume: true };
      }
      if (this.reader && matchesKey(data, "home")) {
        this.reader.scroll.scrollToStart();
        this.tui.requestRender();
        return { consume: true };
      }
      if (this.reader && matchesKey(data, "end")) {
        this.reader.scroll.scrollToEnd();
        this.tui.requestRender();
        return { consume: true };
      }
      return undefined;
    }
    if (this.input.isShowingAutocomplete() && action === "cancel")
      return undefined;
    if (action === "palette") {
      this.dispatch("commands");
      return { consume: true };
    }
    if (action === "cancel") {
      if (this.detailKind) this.clearDetails();
      else if (this.app?.busy) this.app.stop();
      return { consume: true };
    }
    if (action === "model") {
      this.dispatch("model");
      return { consume: true };
    }
    if (action === "tools") {
      this.dispatch("tools");
      return { consume: true };
    }
    if (action === "next") {
      void this.submit(this.input.getExpandedText(), "next").catch((e) =>
        this.showError(e),
      );
      return { consume: true };
    }
    if (action === "interrupt") {
      if (this.app?.busy) this.app.stop();
      else if (this.input.getExpandedText()) {
        this.app?.setDraft(this.input.getExpandedText());
        this.input.setText("");
        if (this.draftTimer) clearTimeout(this.draftTimer);
        this.notice =
          "入力を下書きとして保存しました。/sessions で復元できます。";
        this.render();
      } else this.dispatch("quit");
      return { consume: true };
    }
    if (action === "eof" && !this.input.getExpandedText()) {
      this.dispatch("quit");
      return { consume: true };
    }
    return undefined;
  }
  async start(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new AgentError(
        "TTY_REQUIRED",
        "agent は対話端末が必要です。端末から agent を起動してください。",
      );
    const done = new Promise<void>((resolve, reject) => {
      this.done = resolve;
      this.fail = reject;
    });
    const signal = () => {
      if (!this.app?.session) {
        this.earlyExit = true;
        this.restore();
        return;
      }
      void this.shutdown().catch((e) => this.fail(e));
    };
    const exception = (error: unknown) => {
      this.fatal = error;
      this.restore();
      void this.shutdown().catch(() => {});
      this.fail(error);
    };
    process.on("SIGINT", signal);
    process.on("SIGTERM", signal);
    process.on("uncaughtException", exception);
    process.on("unhandledRejection", exception);
    this.disposeSignals = () => {
      process.off("SIGINT", signal);
      process.off("SIGTERM", signal);
      process.off("uncaughtException", exception);
      process.off("unhandledRejection", exception);
    };
    this.tui.start();
    const updateColors = (colors: Parameters<typeof terminalTheme>[0]) => {
      if (this.closing) return;
      terminalTheme(colors);
      this.tui.invalidate();
      this.tui.requestRender();
    };
    // Color discovery never delays input or loads provider code.
    void this.tui
      .queryTerminalColors({ timeoutMs: 150, onLateReply: updateColors })
      .then(updateColors, () => {});
    try {
      const p = paths(this.home);
      await privateDirectory(p.home);
      let config: Config;
      try {
        config = await loadConfig(p);
      } catch (error) {
        if (!(error instanceof AgentError) || error.code !== "NOT_INITIALIZED")
          throw error;
        await initialize(p, {
          schemaVersion: 1,
          defaults: { mode: "single", dataClass: "private" },
        });
        config = await loadConfig(p);
      }
      if (this.earlyExit) return;
      this.app = new Application(config, p, new Store(p), process.cwd());
      this.app.on("event", (event: AppEvent) => this.event(event));
      await this.app.initialize();
      if (this.earlyExit) {
        await this.shutdown();
        return;
      }
      this.notice = "";
      this.input.setText(this.app.session.draft);
      this.render();
      await done;
    } finally {
      try {
        if (!this.closing) await this.shutdown();
      } finally {
        this.restore();
        this.disposeSignals?.();
        if (this.fatal) process.exitCode = 1;
      }
    }
  }
  private restore(): void {
    if (this.restored) return;
    this.restored = true;
    this.tui.stop({ preserveScreen: true });
  }
  private async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.draftTimer) clearTimeout(this.draftTimer);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.loginAbort?.abort();
    this.cancelDialog?.();
    try {
      if (this.app?.session) {
        this.app.setDraft(
          this.input.getExpandedText() || this.app.session.draft,
        );
        try {
          await this.app.close();
        } finally {
          this.app.store.close();
        }
      }
      await this.terminal.drainInput(300, 30);
    } finally {
      this.restore();
      this.done();
    }
  }
  private event(event: AppEvent): void {
    if (!this.app || event.sessionId !== this.app.session.id) return;
    if (
      event.runId &&
      this.app.activeRunId &&
      event.runId !== this.app.activeRunId
    )
      return;
    if (
      event.detail.generation &&
      event.runId &&
      this.app.view(event.runId).run?.generation !== event.detail.generation
    )
      return;
    if (event.type === "text_delta") {
      const key = String(event.detail.taskId ?? "work"),
        text = String(event.detail.text ?? "");
      // Full text is persisted by Pi; the live preview has a bounded byte budget.
      if (this.streamBytes + Buffer.byteLength(text) <= 48000) {
        this.stream.set(key, (this.stream.get(key) ?? "") + text);
        this.streamBytes += Buffer.byteLength(text);
      }
    } else if (
      event.type === "tool_started" ||
      event.type === "tool_finished"
    ) {
      this.activity.tool(event.detail, event.type === "tool_started");
    } else if (event.type === "validation_started") {
      this.activity.checks.clear();
      for (const id of this.app.currentRun()?.checks ?? [])
        this.activity.checks.set(id, {
          label: `検査 / ${id}`,
          target: this.app.config.checks[id]?.command ?? "",
          state: "pending",
        });
    } else if (event.type === "instructions_accepted") {
      this.activity.clear();
    } else if (
      event.type === "check_started" ||
      event.type === "check_finished"
    ) {
      const detail = event.detail;
      this.activity.checks.set(String(detail.checkId), {
        label: `検査 / ${detail.checkId}`,
        target: String(detail.command ?? ""),
        state:
          event.type === "check_started"
            ? "running"
            : detail.unknown
              ? "unknown"
              : detail.passed
                ? "succeeded"
                : "failed",
      });
    } else if (
      event.type === "task_succeeded" ||
      event.type === "task_failed"
    ) {
      const key = String(event.detail.taskId);
      this.streamBytes -= Buffer.byteLength(this.stream.get(key) ?? "");
      this.stream.delete(key);
    } else if (event.type === "notice") this.notice = String(event.detail.text);
    else if (event.type === "run_started" || event.type === "session") {
      this.stream.clear();
      this.streamBytes = 0;
      this.activity.clear();
      if (event.type === "run_started") this.notice = "";
      if (event.type === "session") {
        this.layout.scroll.scrollToEnd();
        this.tui.resetTextSelection();
        this.input.setText(this.app.session.draft);
        for (const message of this.app
          .history()
          .filter((m) => m.role === "user"))
          this.input.addToHistory(message.text);
        const run = this.app.currentRun();
        this.notice = run?.reason
          ? failureGuidance(run.reason, this.app.config, this.app.session)
          : this.app.interrupted()
            ? "前の作業は未完了です。/tasks で確認し /resume で明示再開できます。"
            : "会話を開きました。待機入力は /queue で確認できます。";
      }
    } else if (event.type === "run_finished") {
      this.stream.clear();
      this.streamBytes = 0;
      const run = this.app.currentRun();
      if (run?.state === "succeeded")
        this.notice =
          run.kind === "coding"
            ? "検査完了 · /diff で変更を確認・適用"
            : run.kind === "chat"
              ? ""
              : "完了 · 成果物を /artifacts で確認できます。";
      else {
        this.notice = `${run ? runLabels[run.state] : "未完了"} · ${failureGuidance(run?.reason ?? "作業は未完了です。", this.app.config, this.app.session)}`;
        if (run?.state === "waiting_approval")
          this.notice += "\n/reconcile で未確定操作を照合してください。";
        else if (!run?.reason?.startsWith("NO_MODEL"))
          this.notice +=
            "\n/status で詳細 · 待機入力は /queue に保存されています。";
      }
    }
    if (!this.renderTimer)
      this.renderTimer = setTimeout(() => {
        this.renderTimer = undefined;
        this.render();
      }, 60);
  }
  private render(): void {
    if (this.closing || !this.app) return;
    const app = this.app,
      run = app.currentRun();
    this.transcript.name = app.session.name;
    this.transcript.workspace = app.session.workspace;
    const latest = app.history();
    if (this.historySession !== app.session.id) {
      this.historySession = app.session.id;
      this.messages = [];
      this.hasOlder = latest.length === 30;
      this.detailKind = "";
      this.inlineDetails.setText("");
      this.transcript.setMessages([]);
    }
    const merged = new Map(
      this.messages.map((message) => [message.seq, message]),
    );
    for (const message of latest) merged.set(message.seq, message);
    this.messages = [...merged.values()].sort((a, b) => a.seq - b.seq);
    this.transcript.setMessages(this.messages);
    this.transcript.hasOlder = this.hasOlder;
    this.transcript.setup = setupSummary(app.config, app.session);
    const recent = app
      .sessions()
      .find((s) => s.id !== app.session.id && (s.draft || s.latestRunId));
    this.transcript.recent = recent
      ? `/continue 前回の会話へ · ${safeText(recent.name)}${recent.draft ? " · 下書きあり" : ""}`
      : "";
    const preparing = app.busy && !app.activeRunId;
    this.activity.run = preparing ? undefined : run;
    this.activity.busy = app.busy;
    const streams = [...this.stream].slice(-2);
    this.activity.previewing = streams.length > 0;
    const width = Math.max(1, this.terminal.columns - 2);
    // Model labels stay outside clipped previews; full responses remain in history.
    const preview = streams
      .map(([task, text]) =>
        [
          theme.muted(
            `生成中 · ${safeText(run?.tasks.find((item) => item.id === task)?.model ?? task)}`,
          ),
          ...markdown(text)
            .render(width)
            .slice(streams.length > 1 ? -2 : -4),
        ].join("\n"),
      )
      .join("\n");
    this.progress.setText(preview);
    const pending = app.session.queue[0];
    const notice = preparing
      ? ""
      : this.notice ||
        (!app.busy && app.session.workRunId
          ? "未適用の変更 · /diff で確認・適用"
          : "");
    this.notification.setText(
      notice
        ? (run?.state === "failed" || notice.startsWith("エラー")
            ? theme.error
            : theme.accent)(safeText(notice)) + "\n"
        : "",
    );
    this.status.setText(
      [
        ...(app.busy ? [theme.muted("作業中 · Esc 停止")] : []),
        ...(pending
          ? [
              theme.muted(
                truncateToWidth(
                  `待機 ${app.session.queue.length} 件 · ${pending.mode === "instruction" ? "追加指示" : "次の依頼"}: ${safeText(pending.text).replace(/\s+/g, " ")}`,
                  width,
                ),
              ),
            ]
          : []),
      ].join("\n"),
    );
    this.tui.requestRender();
  }
  private showError(error: unknown): void {
    this.notice = `エラー · ${safeText(this.app ? failureGuidance(errorMessage(error), this.app.config, this.app.session) : errorMessage(error))}\n/status で詳細`;
    this.render();
  }
  private dispatch(command: string): void {
    void this.command(command).catch((e) => this.showError(e));
  }
  private async submit(
    text: string,
    mode: "instruction" | "next" = "instruction",
  ): Promise<void> {
    if (!this.app) {
      this.notice = "起動処理中です。入力は保持しています。";
      return;
    }
    if (text.startsWith("/")) {
      this.input.setText("");
      await this.command(text.slice(1));
      return;
    }
    if (!text.trim()) return;
    const preview = await this.app.previewInput(text);
    if (!(await this.confirmInput(preview))) {
      this.input.setText(text);
      return;
    }
    if (!this.app.busy) this.notice = "";
    await this.app.submit(text, mode, preview);
    if (this.input.getExpandedText() === text) this.input.setText("");
    this.input.addToHistory(text);
    this.render();
  }
  private async confirmInput(
    preview: Awaited<ReturnType<Application["previewInput"]>>,
  ): Promise<boolean> {
    if (
      !preview.attachments.length &&
      !preview.images.length &&
      !preview.accessOverride
    )
      return true;
    return this.confirm(
      [
        ...(preview.accessOverride
          ? [
              `一回限りの access override: ${preview.accessOverride}（確認後、この送信で消費）`,
              ...(preview.accessOverride !== preview.access
                ? [
                    "現在の依頼に明示的な禁止があるため、有効 access は read-only です。",
                  ]
                : []),
            ]
          : []),
        ...preview.attachments
          .filter((ref) => !ref.mimeType)
          .map((ref) => `資料: ${ref.path} (${ref.bytes} bytes)`),
        ...preview.images.map(
          (ref, index) =>
            `画像 ${index + 1}: ${ref.name} · ${ref.mimeType} · ${ref.width}×${ref.height} · ${ref.bytes} bytes\n参照ID: ${ref.id}`,
        ),
        `送信区分: ${preview.dataClass}${preview.localOnly ? " / local-only" : ""}`,
        ...(preview.images.length
          ? [
              "保存済み画像も含めて送信します。",
              "送信先（自動振り分けを含む候補）:",
              ...preview.destinations,
            ]
          : []),
      ].join("\n"),
    );
  }
  private closeDialog(): void {
    this.tui.hideOverlay();
    this.cancelDialog = undefined;
    this.reader = undefined;
    this.acceptReader = undefined;
    this.tui.setFocus(this.input);
    this.tui.requestRender();
  }
  private async choose(
    title: string,
    choices: { value: string; label: string; description?: string }[],
    searchable = choices.length > 5,
  ): Promise<string | undefined> {
    if (this.tui.hasOverlay())
      throw new AgentError("DIALOG", "現在の画面を閉じてください。");
    return new Promise((resolve) => {
      const picker = new Picker(
        safeText(title),
        choices.map((c) => ({
          ...c,
          label: safeText(c.label),
          description: c.description && safeText(c.description),
        })),
        searchable,
        () => this.terminal.rows,
      );
      const finish = (value?: string) => {
        this.closeDialog();
        resolve(value);
      };
      picker.onSelect = finish;
      this.cancelDialog = () => finish();
      this.tui.showOverlay(new ResponsiveOverlay(picker), {
        width: "100%",
        margin: 1,
        anchor: "center",
      });
    });
  }
  private async editSettings(
    title: string,
    fields: SettingsField[],
    position: SettingsPosition,
  ): Promise<SettingsEdit | undefined> {
    return new Promise((resolve) => {
      const panel = new SettingsEditor(
        title,
        fields,
        position,
        () => this.terminal.rows,
      );
      const finish = (value?: SettingsEdit) => {
        this.closeDialog();
        resolve(value);
      };
      panel.onSubmit = finish;
      this.cancelDialog = () => {
        if (!panel.cancel()) finish();
        else this.tui.requestRender();
      };
      this.tui.showOverlay(new ResponsiveOverlay(panel, 112), {
        width: "100%",
        margin: 1,
        anchor: "center",
      });
    });
  }
  private async prompt(
    title: string,
    value = "",
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (signal?.aborted) return undefined;
    return new Promise((resolve) => {
      const dialog = new Dialog(safeText(title));
      const control = editor(this.tui);
      control.setText(safeText(value));
      const cancel = () => finish();
      const finish = (text?: string) => {
        signal?.removeEventListener("abort", cancel);
        this.closeDialog();
        resolve(text);
      };
      control.onSubmit = (text) => finish(text);
      dialog.setControl(control);
      this.cancelDialog = cancel;
      this.tui.showOverlay(new ResponsiveOverlay(dialog), {
        width: "100%",
        margin: 1,
        anchor: "center",
      });
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }
  private async confirm(title: string): Promise<boolean> {
    // Long paths and permission scopes must remain readable before approval.
    if (
      new Text(safeText(title), 0, 0).render(
        Math.max(16, this.terminal.columns - 12),
      ).length > 3
    ) {
      if (!(await this.show(title, "実行内容を確認", "確認へ進む")))
        return false;
      title = "表示した内容で実行しますか？";
    }
    return (
      (await this.choose(title, [
        { value: "no", label: "取消" },
        { value: "yes", label: "実行する" },
      ])) === "yes"
    );
  }
  private async show(
    text: string,
    title = "詳細",
    accept = "",
  ): Promise<boolean> {
    if (this.tui.hasOverlay()) return false;
    return new Promise((resolve) => {
      this.reader = new Reader(this.tui, text, title, accept);
      this.cancelDialog = () => {
        this.closeDialog();
        resolve(false);
      };
      if (accept)
        this.acceptReader = () => {
          this.closeDialog();
          resolve(true);
        };
      this.tui.showOverlay(new ResponsiveOverlay(this.reader, 104), {
        width: "100%",
        margin: 1,
        anchor: "center",
      });
    });
  }
  private async command(line: string): Promise<void> {
    const app = this.app;
    if (!app) return;
    if (this.busyDialog)
      throw new AgentError("BUSY", "認証・診断の終了を待ってください。");
    const [command, ...args] = line.trim().split(/\s+/);
    const argument = args.join(" ");
    if (command !== "status") this.notice = "";
    switch (command) {
      case "commands": {
        const preferred = app.busy
          ? ["tasks", "stop", "queue"]
          : app.session.workRunId
            ? ["diff", "apply"]
            : Object.keys(app.config.models).length
              ? ["continue", "sessions", "model", "new"]
              : ["settings", "login", "doctor"];
        const items = commands
          .filter((item) => item.name !== "commands")
          .sort(
            (a, b) =>
              (preferred.includes(a.name) ? preferred.indexOf(a.name) : 99) -
              (preferred.includes(b.name) ? preferred.indexOf(b.name) : 99),
          );
        const selected = await this.choose(
          "操作を検索",
          items.map((item) => ({
            value: item.name,
            label: item.description,
            description: `/${item.name}`,
          })),
          true,
        );
        if (selected) await this.command(selected);
        break;
      }
      case "status": {
        const run = app.currentRun(),
          view = app.view();
        await this.show(
          [
            `会話: ${app.session.name}`,
            `作業場所: ${app.session.workspace}`,
            `モデル: ${app.session.model || "自動選択"} · 構成: ${{ single: "単独", reviewed: "レビュー付き", assisted: "計画・委任" }[app.session.strategy]}`,
            `送信区分: ${app.session.dataClass} · ${app.session.localOnly ? "ローカルのみ" : "許可した接続を使用"}`,
            `状態: ${run ? runLabels[run.state] : "未実行"}`,
            run?.reason
              ? failureGuidance(run.reason, app.config, app.session)
              : this.notice,
            ...(run?.reason ? ["\n技術詳細", safeText(run.reason)] : []),
            "",
            `要求: ${view.usage?.requests ?? 0}/${app.config.limits.maxRequests}`,
            view.context
              ? `コンテキスト推定: ${view.context.bytes}/${view.context.limit} bytes · 残り約 ${Math.max(0, view.context.limit - view.context.bytes)} bytes${view.context.imageCount ? ` · 画像 ${view.context.imageCount} 件 / 約 ${view.context.estimatedImageTokens} tokens相当 (heuristic)` : ""}`
              : "コンテキスト推定: 不明",
            `プロバイダー報告: 入力 ${view.usage?.input ?? "不明"} / 出力 ${view.usage?.output ?? "不明"} tokens${view.usage?.usageComplete ? "" : " · 使用量不明または一部未報告"}`,
            `待機入力: ${app.session.queue.length} 件`,
            "詳しい担当・検査は /tasks、接続の変更は /settings。",
          ].join("\n"),
          "状態と利用量",
        );
        break;
      }
      case "help":
        await this.show(
          "操作\n\n" +
            commands.map((c) => `/${c.name} — ${c.description}`).join("\n") +
            "\n\nキー\n" +
            Object.values(actions)
              .map((a) => `${a.keys.join(" / ")} — ${a.description}`)
              .join("\n") +
            "\nShift+Enter — 改行\nEnter — 送信／実行中は追加指示\nTab — コマンド・パス・@ファイル補完\n↑/↓ — 入力履歴\nCtrl+C の空入力、Ctrl+D の空入力、/quit は保存して終了。作業中のみ確認します。\n/tools list — 保存済みツール結果を選ぶ\n/expand [番号] — 長文の続きを同じ場所に表示",
        );
        break;
      case "new":
        await app.newSession();
        break;
      case "continue": {
        const recent = app
          .sessions()
          .find((s) => s.id !== app.session.id && (s.draft || s.latestRunId));
        if (recent) app.openSession(recent.id);
        else this.notice = "保存済みの会話はありません。";
        break;
      }
      case "sessions": {
        let offset = 0;
        while (true) {
          const sessions = app.sessions(offset);
          const selected = await this.choose(
            "会話を開く",
            [
              ...sessions.map((s) => {
                const run = s.latestRunId
                  ? app.store.get(s.latestRunId)
                  : undefined;
                return {
                  value: s.id,
                  label: s.name,
                  description:
                    `${s.draft ? "下書きあり · " : ""}${s.queue.length ? `待機 ${s.queue.length} 件 · ` : ""}` +
                    (s.id === app.session.id
                      ? "現在の会話"
                      : run
                        ? runLabels[run.state]
                        : "未実行"),
                };
              }),
              ...(sessions.length === 30
                ? [{ value: "older", label: "さらに前の会話" }]
                : []),
            ],
            true,
          );
          if (selected === "older") {
            offset += 30;
            continue;
          }
          if (selected) app.openSession(selected);
          break;
        }
        break;
      }
      case "rename": {
        const name =
          argument || (await this.prompt("会話名", app.session.name));
        if (name) {
          app.session.name = name;
          app.save();
        }
        break;
      }
      case "resume":
        await app.resume();
        break;
      case "stop":
        if (app.busy) app.stop();
        break;
      case "quit":
        if (
          !app.busy ||
          (await this.confirm(
            "作業を中断し、下書き・待機入力を保存して終了しますか？",
          ))
        )
          await this.shutdown();
        break;
      case "next": {
        const text = argument || (await this.prompt("完了後の依頼"));
        if (text) await this.submit(text, "next");
        break;
      }
      case "queue":
        await this.queue();
        break;
      case "kind": {
        const kind = await this.choose(
          "依頼の種類（通常は自動判定）",
          ["auto", "chat", "coding", "writing", "research"].map((value) => ({
            value,
            label: value,
          })),
        );
        if (kind) {
          app.session.kind = kind as typeof app.session.kind;
          app.save();
        }
        break;
      }
      case "access": {
        if (argument === "read-only" || argument === "change") {
          app.setAccessOverride(argument);
          this.notice = `次の送信1回のみ ${argument} を使用します。確認後に消費されます。`;
        } else this.notice = "/access read-only|change";
        break;
      }
      case "history":
        await this.history();
        break;
      case "expand":
        this.layout.scroll.scrollAfterLayout(this.layout.scroll.scrollTop);
        if (this.detailKind && !argument) {
          this.detailLimit += 24000;
          this.renderDetails();
        } else if (
          !this.transcript.expand(argument ? Number(argument) : undefined)
        )
          this.notice = "展開する長文はありません。";
        break;
      case "model":
        await this.model();
        break;
      case "tasks": {
        const run = app.currentRun();
        if (!run) {
          this.notice = "まだ実行していません。";
          break;
        }
        if (this.detailKind === "作業詳細") {
          this.clearDetails();
          break;
        }
        const sessionId = app.session.id;
        const checks = await app.lastValidation(run.id);
        if (sessionId !== app.session.id) break;
        const view = app.view(run.id);
        this.showDetails(
          "作業詳細",
          [
            taskDetails(run),
            "検査コマンド",
            ...(run.checks.length
              ? run.checks.map(
                  (id) =>
                    `${id}: ${app.config.checks[id]?.command ?? "設定なし"}`,
                )
              : ["この作業には検査コマンドを指定していません。"]),
            "\n保存済み検査（直近の完了分）",
            ...(checks
              ? checks.map(
                  (check) =>
                    `${check.passed ? "合格" : "不合格"} / ${check.id}\n${check.detail}`,
                )
              : ["完了した検査結果はありません。"]),
            "\n利用量",
            `${view.usage?.requests ?? 0}/${app.config.limits.maxRequests} 要求 · 入力 ${view.usage?.input ?? "不明"} / 出力 ${view.usage?.output ?? "不明"} tokens`,
            ...(view.context
              ? [
                  `コンテキスト: ${view.context.bytes}/${view.context.limit} bytes · ${view.context.model} / ${view.context.taskId}`,
                ]
              : []),
            "\n/artifacts 検査の詳細 · Ctrl+O ツール結果",
          ].join("\n"),
        );
        break;
      }
      case "diff":
      case "apply": {
        const diff = await app.diff();
        const added = diff.patch
            .split("\n")
            .filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
          removed = diff.patch
            .split("\n")
            .filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
        const accepted = await this.show(
          `変更 ${diff.files.length} ファイル · +${added} / -${removed}\n${diff.files.join("\n")}\n適用: ${diff.applicable ? "可能" : (diff.reason ?? "不可")}\n\n\`\`\`diff\n${diff.patch}\n\`\`\``,
          "変更を確認",
          diff.applicable ? "適用へ進む" : "",
        );
        if (
          accepted &&
          diff.applicable &&
          (await this.confirm(
            `${diff.files.length} ファイルの検証済み変更を ${app.session.workspace} へ適用しますか？`,
          ))
        )
          await app.apply(diff.token);
        break;
      }
      case "images":
        this.showDetails(
          "保存済み画像",
          app.session.images?.length
            ? app.session.images
                .map(
                  (ref, index) =>
                    `${index + 1}. ${ref.name}\n${ref.id}\n${ref.mimeType} · ${ref.width}×${ref.height} · ${ref.bytes} bytes\n元画像: ${app.imagePath(ref)}`,
                )
                .join("\n\n")
            : '画像はありません。@画像.png または @"空白を含む画像.jpg" で添付できます。SSH では接続先の作業ディレクトリからの相対パスを指定してください。',
        );
        break;
      case "artifacts":
      case "tools":
        if (
          command === "tools" &&
          this.detailKind === "ツール結果" &&
          !argument
        )
          this.clearDetails();
        else
          await this.artifacts(
            command === "tools",
            undefined,
            argument === "list",
          );
        break;
      case "compact":
        await app.compact();
        break;
      case "pins": {
        const [operation, noteId, ...rest] = args;
        if (!argument || operation === "list") {
          await this.show(
            app
              .pins()
              .map((pin) => `${pin.id}  ${pin.text}`)
              .join("\n") || "固定メモはありません。",
            "固定メモ",
          );
          break;
        }
        if (operation === "add") {
          const text =
            args.slice(1).join(" ") || (await this.prompt("固定メモ", ""));
          if (text) app.addPin(text);
        } else if (operation === "remove" && noteId) app.removePin(noteId);
        else if (operation === "edit" && noteId) {
          const text = rest.join(" ") || (await this.prompt("固定メモ", ""));
          if (text) app.editPin(noteId, text);
        } else this.notice = "/pins add|remove|edit [id] [text]";
        break;
      }
      case "context": {
        if (args[0] === "read" && args[1])
          await this.show(
            await app.readContext(
              args[1],
              args[2] === undefined ? 0 : Number(args[2]),
              args[3] === undefined ? 32_000 : Number(args[3]),
            ),
            "保存済みコンテキスト",
          );
        else if (args[0] === "original" && args[1])
          await this.show(
            app.contextOriginal(
              Number(args[1]),
              args[2] === undefined ? 0 : Number(args[2]),
              args[3] === undefined ? 32_000 : Number(args[3]),
            ),
            "会話原文",
          );
        else if (args[0] === "edit" && args[1]) {
          const text =
            args.slice(2).join(" ") || (await this.prompt("メモ", ""));
          if (text) app.editContextNote(args[1], text);
        } else if (
          args[0] === "add" &&
          ["decision", "question"].includes(args[1] ?? "")
        ) {
          const text =
            args.slice(2).join(" ") || (await this.prompt("メモ", ""));
          if (text)
            app.addContextNote(args[1] as "decision" | "question", text);
        } else if (args[0] === "constraint" && args[1] === "add") {
          const text =
            args.slice(2).join(" ") || (await this.prompt("制約", ""));
          if (text) app.addConstraint(text);
        } else if (args[0] === "constraint" && args[1] === "remove" && args[2])
          app.removeConstraint(Number(args[2]));
        else await this.show(app.contextDetails(), "会話コンテキスト");
        break;
      }
      case "settings":
        await new SettingsDialog(app, {
          edit: this.editSettings.bind(this),
          choose: (title, choices) => this.choose(title, choices, true),
          prompt: this.prompt.bind(this),
          confirm: this.confirm.bind(this),
          run: async (command) => {
            await this.command(command);
          },
          notify: (text) => {
            this.notice = text;
          },
        }).open();
        break;
      case "doctor":
        this.busyDialog = true;
        try {
          const report = await app.doctor();
          if (
            await this.show(
              doctorSummary(report),
              "診断 · モデル呼出しなし",
              "技術詳細",
            )
          )
            await this.show(JSON.stringify(report, null, 2), "診断の技術詳細");
        } finally {
          this.busyDialog = false;
        }
        break;
      case "login":
        await this.login(argument);
        break;
      case "probe":
        await this.probe(argument);
        break;
      case "reconcile":
        await this.reconcile();
        break;
      default:
        throw new AgentError(
          "COMMAND",
          "不明な操作です。/help で確認してください。",
        );
    }
    this.render();
  }
  private async history(): Promise<void> {
    this.loadOlder();
    this.layout.scroll.scrollToStart();
    this.tui.requestRender();
  }
  private loadOlder(remaining?: number): void {
    if (!this.app || !this.hasOlder || !this.messages.length) return;
    const width = Math.max(1, this.terminal.columns - 2);
    const height = this.transcript.render(width).length;
    const older = this.app.history(this.messages[0]!.seq);
    this.hasOlder = older.length === 30;
    this.messages = [...older, ...this.messages];
    this.transcript.hasOlder = this.hasOlder;
    this.transcript.setMessages(this.messages);
    if (remaining !== undefined)
      this.layout.scroll.preserveAfterPrepend(
        this.transcript.render(width).length - height,
        remaining,
      );
    this.tui.requestRender();
  }
  private clearDetails(): void {
    this.detailKind = "";
    this.inlineDetails.setText("");
    if (this.detailReturn.following) this.layout.scroll.scrollToEnd();
    else this.layout.scroll.scrollAfterLayout(this.detailReturn.top);
    this.tui.requestRender();
  }
  private showDetails(kind: string, text: string): void {
    if (!this.detailKind)
      this.detailReturn = {
        top: this.layout.scroll.scrollTop,
        following: this.layout.scroll.isFollowingEnd,
      };
    this.detailKind = kind;
    this.detailText = text;
    this.detailLimit = 24000;
    this.renderDetails();
    const width = Math.max(1, this.terminal.columns - 2);
    this.layout.scroll.scrollAfterLayout(
      this.transcript.render(width).length +
        this.progress.render(width).length +
        this.activity.render(width).length,
    );
    this.tui.requestRender();
  }
  private renderDetails(): void {
    this.inlineDetails.setText(
      safeText(
        `\n## ${this.detailKind} · Esc で閉じる\n\n${excerpt(this.detailText, this.detailLimit)}${Buffer.byteLength(this.detailText) > this.detailLimit ? "\n\n… /expand で続きを表示" : ""}`,
      ),
    );
  }
  private async queue(): Promise<void> {
    const app = this.app!;
    if (!app.session.queue.length) {
      this.notice = "待機入力はありません · Alt+Enter で次の依頼を保存";
      return;
    }
    const value = await this.choose("待機入力（停止・再起動後は明示実行）", [
      ...app.session.queue.map((q) => ({
        value: q.id,
        label: q.text,
        description:
          q.mode === "instruction" ? "現在の作業への追加指示" : "完了後の依頼",
      })),
      { value: "start", label: "待機依頼を実行" },
    ]);
    if (value === "start") {
      app.startQueue();
      return;
    }
    const item = app.session.queue.find((q) => q.id === value);
    if (!item) return;
    const action = await this.choose(item.text, [
      { value: "edit", label: "編集" },
      { value: "cancel", label: "取消" },
      { value: "next", label: "次の依頼として実行待ちにする" },
    ]);
    if (action === "edit") {
      const text = await this.prompt("待機入力を編集", item.text);
      if (text !== undefined) {
        const preview = await app.previewInput(text);
        if (await this.confirmInput(preview))
          app.editQueued(item.id, text, preview);
      }
    }
    if (action === "cancel") app.cancelQueued(item.id);
    if (action === "next") {
      item.mode = "next";
      item.runId = undefined;
      app.save();
    }
  }
  private async artifacts(
    tools = false,
    runId = this.app!.session.latestRunId,
    list = false,
  ): Promise<void> {
    const app = this.app!;
    if (!runId) {
      this.notice = "保存済みの結果はありません。";
      return;
    }
    const artifacts = app
      .view(runId)
      .artifacts.filter((a) => !tools || !!a.metadata.tool);
    if (tools && !artifacts.length && !list) {
      this.notice =
        "この作業のツール結果はありません · /tools list で以前の作業へ";
      return;
    }
    const selected =
      tools && !list
        ? artifacts.at(-1)?.id
        : await this.choose(
            tools ? "ツールの保存済み結果" : "成果物・出典・検査",
            [
              ...artifacts.map((a) => ({
                value: a.id,
                label: a.name,
                description: `${a.kind} · ${a.bytes} bytes`,
              })),
              { value: "previous", label: "前の作業の成果物を開く" },
            ],
          );
    if (selected === "previous") {
      let offset = 0;
      while (true) {
        const runs = app.artifactRuns(offset);
        const selectedRun = await this.choose("この会話の作業", [
          ...runs.map((run) => ({
            value: run.id,
            label: run.objective,
            description: run.state,
          })),
          ...(runs.length === 30
            ? [{ value: "older", label: "さらに前の作業" }]
            : []),
        ]);
        if (selectedRun === "older") {
          offset += 30;
          continue;
        }
        if (selectedRun) await this.artifacts(tools, selectedRun, true);
        return;
      }
    }
    const artifact = artifacts.find((a) => a.id === selected);
    if (!artifact) return;
    const text = await app.artifactText(artifact.id, runId);
    if (tools) {
      this.showDetails(
        "ツール結果",
        `${artifact.name}\n\n${text}\n\n/tools list で別の結果を選択 · Ctrl+O で閉じる`,
      );
      return;
    }
    await this.show(
      `${artifact.name}\n${JSON.stringify(artifact.metadata)}\n\n${text}`,
    );
  }
  private async model(): Promise<void> {
    const app = this.app!;
    const models = (current?: string) => [
      {
        value: "@auto",
        label: "自動選択",
        description: current ? "許可・用途に応じて選択" : "現在の選択",
      },
      ...Object.entries(app.config.models).map(([name, model]) => ({
        value: name,
        label: name,
        description: `${name === current ? "現在 · " : ""}${app.config.connections[model.connection]!.enabled ? model.connection : "接続無効"} / ${model.id}`,
      })),
    ];
    const value = await this.choose(
      "モデルを選択（次の依頼から）",
      [
        ...models(app.session.model),
        {
          value: "@reviewer",
          label: "レビュー担当を変更",
          description: app.session.reviewer ?? "自動選択",
        },
        {
          value: "@strategy",
          label: "担当構成を変更",
          description: app.session.strategy,
        },
      ],
      true,
    );
    if (!value) return;
    if (value === "@strategy") {
      const mode = await this.choose("担当構成", [
        { value: "single", label: "単独" },
        { value: "reviewed", label: "実務担当＋独立レビュー" },
        { value: "assisted", label: "主担当による計画・委任" },
      ]);
      if (!mode) return;
      app.session.strategy = mode as typeof app.session.strategy;
    } else if (value === "@reviewer") {
      const model = await this.choose(
        "レビュー担当を選択",
        models(app.session.reviewer),
        true,
      );
      if (!model) return;
      app.session.reviewer = model === "@auto" ? undefined : model;
    } else app.session.model = value === "@auto" ? undefined : value;
    app.save();
    this.notice = "モデル・構成を保存しました。次の依頼から反映します。";
  }
  private async login(name: string): Promise<void> {
    const app = this.app!;
    if (app.busy)
      throw new AgentError("BUSY", "作業の完了後にログインしてください。");
    name =
      name ||
      (await this.choose(
        "ログインする接続",
        Object.entries(app.config.connections)
          .filter(([, c]) => c.type === "chatgpt")
          .map(([value]) => ({ value, label: value })),
      )) ||
      "";
    if (!name) return;
    this.loginAbort = new AbortController();
    this.busyDialog = true;
    try {
      await interactiveLogin(app.config, app.paths, name, {
        signal: this.loginAbort.signal,
        show: (text) => {
          this.notice = "ログイン中（Esc で取消）";
          if (this.tui.hasOverlay()) this.closeDialog();
          const content = new Reader(
            this.tui,
            text,
            "認証画面をブラウザーで開いてください。Esc: 取消",
          );
          this.tui.showOverlay(content, {
            width: "95%",
            anchor: "bottom-center",
          });
          this.cancelDialog = () => {
            this.closeDialog();
            this.loginAbort?.abort();
          };
        },
        prompt: async (text, choices, signal) => {
          if (this.tui.hasOverlay()) this.closeDialog();
          const value = choices
            ? await this.choose(
                text,
                choices.map((c) => ({ value: c.id, label: c.label })),
              )
            : await this.prompt(text, "", signal);
          if (value === undefined) {
            this.loginAbort?.abort();
            throw new AgentError("CANCELLED", "認証を取り消しました。");
          }
          return value;
        },
      });
      this.notice = "ログイン完了";
    } finally {
      if (this.tui.hasOverlay()) this.closeDialog();
      this.loginAbort = undefined;
      this.busyDialog = false;
    }
  }
  private async probe(name: string): Promise<void> {
    const app = this.app!;
    if (app.busy)
      throw new AgentError("BUSY", "現在の作業を終了してください。");
    name =
      name ||
      (await this.choose(
        "疎通試験するモデル",
        Object.keys(app.config.models).map((value) => ({
          value,
          label: value,
        })),
      )) ||
      "";
    if (!name) return;
    if (
      !(await this.confirm(
        `${name} を実際に呼び出し、ファイルツールの往復を確認します。設定済みの利用枠・予算を消費します。`,
      ))
    )
      return;
    await app.probe(name);
  }
  private async reconcile(): Promise<void> {
    const app = this.app!,
      run = app.currentRun();
    if (!run) return;
    const selected = await this.choose(
      "未確定操作（実際の結果を確認してから記録）",
      app
        .view(run.id)
        .operations.filter((o) => ["unknown", "dispatched"].includes(o.status))
        .map((o) => ({
          value: o.id,
          label: `${o.task_id}: ${o.name}`,
          description: o.status,
        })),
    );
    if (!selected) return;
    const outcome = await this.choose("照合結果", [
      { value: "failed", label: "完了していないことを確認" },
      { value: "completed", label: "完了したことを確認" },
    ]);
    if (!outcome) return;
    const note = await this.prompt("何を確認したか");
    if (note)
      await app.reconcile(selected, outcome as "failed" | "completed", note);
  }
}
export async function startTerminal(home?: string): Promise<void> {
  // Let module-initialization warnings flush before Pi takes ownership of the screen.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new TerminalApp(home).start();
}
