import {
  BoxRenderable,
  RGBA,
  TextRenderable,
  TextAttributes,
  type CliRenderer,
  StyledText,
  type TextChunk,
} from "@opentui/core";
import type { ConversationMessage } from "../conversations.js";
import { basename } from "node:path";
import type { Role, Run, RunState } from "../types.js";
import {
  markdown,
  safeText,
  theme,
  panelBackground,
  type MarkdownText,
} from "./components.js";

const lineText = (text: string) => safeText(text).replace(/\s+/g, " ");
export function excerpt(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, limit);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString();
}
export const runLabels: Record<RunState, string> = {
  created: "準備中",
  planning: "計画中",
  running: "作業中",
  validating: "検査中",
  repairing: "修正中",
  waiting_input: "入力待ち",
  waiting_quota: "利用枠待ち",
  waiting_approval: "操作の照合待ち",
  succeeded: "完了",
  failed: "失敗",
  cancelled: "中断",
};
const roles: Record<Role, string> = {
  lead: "計画",
  worker: "実務",
  reviewer: "レビュー",
};

export function taskDetails(run: Run): string {
  return [
    `作業状況 · ${runLabels[run.state]}`,
    run.objective,
    ...(run.reason ? [`\n理由: ${run.reason}`] : []),
    ...(run.mode !== "single"
      ? [
          "協調実行: 各担当の報告は未検証のモデル出力です。利用者への最終回答は統合担当だけが作成します。",
        ]
      : []),
    "\n担当",
    ...run.tasks.map((task) =>
      [
        `${activityLabels[task.state]} / ${roles[task.role]} / ${task.id}`,
        `モデル: ${task.model ?? "選択前"} · 試行 ${task.attempts}`,
        `作業コピー: ${task.write ? "変更あり" : "読み取り専用"}${task.role === "reviewer" && run.access === "change" ? "（検査は使い捨てコピー）" : ""}${task.purpose === "synthesis" ? " · 最終回答の統合" : ""}`,
        ...(task.delegatedBy
          ? [
              `委任元: ${task.delegatedBy}`,
              `許可資料: ${task.assignment?.sourceIds.join(", ") || "なし"}`,
            ]
          : []),
        ...(task.dependsOn.length
          ? [`依存する担当: ${task.dependsOn.join(", ")}`]
          : []),
        task.objective,
        ...(task.result
          ? [
              task.result.summary,
              ...task.result.unresolved.map((text) => `未解決: ${text}`),
            ]
          : []),
        ...(task.attemptReportIds?.length
          ? [
              `試行報告: ${task.attemptReportIds.length} 件（直近5件・モデルの報告であり検査の証明ではありません）`,
              ...task.attemptReportIds.slice(-5),
            ]
          : []),
        ...(task.reworkLinks?.length
          ? [
              `修正履歴: ${task.reworkLinks.length} 件（直近3件）`,
              ...task.reworkLinks
                .slice(-3)
                .map(
                  (link) =>
                    `修正 ${link.repairAttempt} · ${link.status === "resolved" ? "後続報告あり（検査合格とは別）" : "未解決"}\n${excerpt(link.reason, 1200)}${Buffer.byteLength(link.reason) > 1200 ? "…（省略）" : ""}\n元の報告: ${link.priorReportIds.join(", ")}\n後続の報告: ${link.resolvedByReportIds?.join(", ") || "なし"}`,
                ),
            ]
          : []),
        "",
      ].join("\n"),
    ),
    ...(run.modelChanges?.length
      ? [
          `モデル切替: ${run.modelChanges.length} 件（直近10件・意味的同等性は未確認）`,
          ...run.modelChanges
            .slice(-10)
            .map(
              (change) =>
                `${change.taskId}: ${change.fromModel} → ${change.toModel}\n再実行対象: ${change.affectedTaskIds.join(", ")}\n変更記録: ${change.reportId}\n${change.supersededByReportId ? `さらに変更: ${change.supersededByReportId}` : change.resolutionReportId ? `実行・検証の記録: ${change.resolutionReportId}（合否・範囲は記録本文を確認）` : "再実行・検証の記録待ち"}`,
            ),
          "報告の全文・過去の記録は /artifacts で確認できます。",
        ]
      : []),
  ].join("\n");
}

const ACCENT = RGBA.fromHex("#56b6c2");

interface MessageView {
  seq: number;
  source: string;
  role: string;
  limit: number;
  container: BoxRenderable;
  body: MarkdownText;
  expandHint: TextRenderable;
}

/**
 * 会話表示。ScrollBox の content に配置されるカラムコンテナ。
 * ユーザ発言は左ボーダー+パネル背景、AGENT はマークダウン本文（opencode 風）。
 */
export class ConversationView extends BoxRenderable {
  private _name = "新しい会話";
  private _workspace = process.cwd();
  get name(): string {
    return this._name;
  }
  set name(value: string) {
    this._name = value;
    this.refreshHeader();
  }
  get workspace(): string {
    return this._workspace;
  }
  set workspace(value: string) {
    this._workspace = value;
    this.refreshHeader();
  }
  setup: string[] = [];
  recent = "";
  private _hasOlder = false;
  private messages: MessageView[] = [];

  private readonly header: TextRenderable;
  private readonly rule: TextRenderable;
  private readonly olderHint: TextRenderable;
  private readonly empty: BoxRenderable;

  constructor(ctx: CliRenderer) {
    // ScrollBox 内に置かれる前提で、内容高を維持するため flexShrink は切る。
    super(ctx, { flexDirection: "column", width: "100%", flexShrink: 0 });
    this.header = new TextRenderable(ctx, {
      content: "",
      flexShrink: 0,
    });
    this.rule = new TextRenderable(ctx, {
      content: new StyledText([theme.muted("─".repeat(300))]),
      wrapMode: "none",
      flexShrink: 0,
    });
    this.olderHint = new TextRenderable(ctx, {
      content: new StyledText([
        theme.muted("↑ スクロールで以前の発言を読込 · /history"),
      ]),
      visible: false,
      flexShrink: 0,
    });
    this.empty = new BoxRenderable(ctx, {
      flexDirection: "column",
      visible: true,
    });
    this.add(this.header);
    this.add(this.rule);
    this.add(this.olderHint);
    this.add(this.empty);
    this.refreshHeader();
  }

  get hasOlder(): boolean {
    return this._hasOlder;
  }
  set hasOlder(value: boolean) {
    this._hasOlder = value;
    this.olderHint.visible = value && this.messages.length > 0;
  }

  private refreshHeader(): void {
    this.header.content = new StyledText([
      theme.strong(lineText(this.name)),
      theme.muted(`  / ${lineText(basename(this.workspace))}`),
    ]);
  }

  private refreshEmpty(): void {
    const ctx = this.ctx as CliRenderer;
    for (const child of [...this.empty.getChildren()]) this.empty.remove(child);
    if (this.messages.length) {
      this.empty.visible = false;
      return;
    }
    this.empty.visible = true;
    for (const line of this.setup) {
      this.empty.add(new TextRenderable(ctx, { content: safeText(line) }));
    }
    if (this.recent) {
      this.empty.add(
        new TextRenderable(ctx, {
          content: new StyledText([theme.muted(safeText(this.recent))]),
        }),
      );
    }
  }

  setMessages(messages: ConversationMessage[]): void {
    const ctx = this.ctx as CliRenderer;
    const previous = new Map(this.messages.map((m) => [m.seq, m]));
    const next: MessageView[] = [];
    let changed = false;
    for (const message of messages) {
      const old = previous.get(message.seq);
      if (old && old.source === message.text && old.role === message.role) {
        next.push(old);
        continue;
      }
      changed = true;
      next.push(this.buildMessage(ctx, message));
    }
    // 消えたメッセージのコンテナを除去
    const keep = new Set(next.map((m) => m.seq));
    for (const old of this.messages) {
      if (!keep.has(old.seq)) {
        this.remove(old.container);
        changed = true;
      }
    }
    // 順序どおりに並べ直す。新規メッセージは seq 昇順で、
    // 既存の最初のコンテナの前に差し込む（履歴の prepend）か末尾に追加する。
    this.messages = next;
    if (changed) {
      const firstMounted = next.findIndex(
        (view) => view.container.parent === this,
      );
      const anchor = firstMounted >= 0 ? next[firstMounted]!.container : null;
      for (let i = 0; i < next.length; i++) {
        const view = next[i]!;
        if (view.container.parent === this) continue;
        if (anchor && i < firstMounted) {
          this.insertBefore(view.container, anchor);
        } else {
          this.add(view.container);
        }
      }
    }
    this.olderHint.visible = this._hasOlder && this.messages.length > 0;
    this.refreshEmpty();
    this.requestRender();
  }

  private buildMessage(
    ctx: CliRenderer,
    message: ConversationMessage,
  ): MessageView {
    const container = new BoxRenderable(ctx, {
      flexDirection: "column",
      width: "100%",
      marginTop: 1,
    });
    const roleLabel = new TextRenderable(ctx, {
      content:
        message.role === "user"
          ? new StyledText([theme.accent("あなた")])
          : new StyledText([theme.strong("AGENT")]),
    });
    const body = markdown(ctx, excerpt(message.text, 6000));
    const expandHint = new TextRenderable(ctx, {
      content: new StyledText([
        theme.muted(`… /expand ${message.seq} で続きを表示`),
      ]),
      visible: Buffer.byteLength(message.text) > 6000,
    });
    container.add(roleLabel);
    if (message.role === "user") {
      // ユーザ発言: 左バー + パネル背景
      const panel = new BoxRenderable(ctx, {
        border: ["left"],
        borderColor: ACCENT,
        backgroundColor: panelBackground(),
        paddingX: 1,
        width: "100%",
      });
      body.paddingLeft = 0;
      panel.add(body);
      container.add(panel);
    } else {
      body.paddingLeft = 2;
      container.add(body);
    }
    container.add(expandHint);
    return {
      seq: message.seq,
      source: message.text,
      role: message.role,
      limit: 6000,
      container,
      body,
      expandHint,
    };
  }

  expand(seq?: number): boolean {
    const message = [...this.messages]
      .reverse()
      .find(
        (item) =>
          (seq === undefined || item.seq === seq) &&
          Buffer.byteLength(item.source) > item.limit,
      );
    if (!message) return false;
    message.limit += 24000;
    message.body.setText(excerpt(message.source, message.limit));
    message.expandHint.visible =
      Buffer.byteLength(message.source) > message.limit;
    return true;
  }
}

export interface ActivityItem {
  label: string;
  target: string;
  state: "pending" | "running" | "succeeded" | "failed" | "unknown";
}
const activityLabels: Record<ActivityItem["state"], string> = {
  pending: "待機",
  running: "実行中",
  succeeded: "完了",
  failed: "失敗",
  unknown: "結果未確定",
};
const toolNames: Record<string, string> = {
  read_file: "読み込み",
  edit_file: "編集",
  write_file: "書き込み",
  list_files: "ファイル一覧",
  search_files: "検索",
  shell: "コマンド",
  web_search: "Web検索",
  fetch_url: "ページ取得",
  read_source: "出典の確認",
};

function activityLineChunks(item: ActivityItem): TextChunk[] {
  const style =
    item.state === "running" || item.state === "unknown"
      ? theme.accent
      : item.state === "failed"
        ? theme.error
        : item.state === "succeeded"
          ? theme.success
          : theme.muted;
  const marker =
    item.state === "running"
      ? ">"
      : item.state === "succeeded"
        ? "+"
        : item.state === "failed" || item.state === "unknown"
          ? "!"
          : "·";
  const chunks: TextChunk[] = [
    style(`${marker} ${activityLabels[item.state]}`),
    { __isChunk: true, text: `  ${lineText(item.label)}` },
  ];
  if (item.target) chunks.push(theme.muted(` · ${lineText(item.target)}`));
  return chunks;
}

function visibleItems(items: ActivityItem[], limit: number): ActivityItem[] {
  const rank = (item: ActivityItem) =>
    item.state === "running" || item.state === "unknown"
      ? 0
      : item.state === "failed"
        ? 1
        : item.state === "pending"
          ? 2
          : 3;
  return [...items]
    .reverse()
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit);
}

/** アクティビティ一覧（ツール・検査の状態表示）。 */
export class ActivityView extends TextRenderable {
  run?: Pick<Run, "state" | "tasks">;
  busy = false;
  previewing = false;
  readonly tools = new Map<string, ActivityItem>();
  readonly checks = new Map<string, ActivityItem>();

  constructor(ctx: CliRenderer) {
    super(ctx, { content: "" });
  }

  clear(): void {
    this.tools.clear();
    this.checks.clear();
    this.refresh();
  }

  tool(detail: Record<string, unknown>, started: boolean): void {
    const key = `${detail.taskId}/${detail.toolId ?? detail.name}`;
    const args = detail.args as { command?: string; path?: string } | undefined;
    const previous = this.tools.get(key);
    this.tools.set(key, {
      label: toolNames[String(detail.name)] ?? String(detail.name),
      target: started
        ? (args?.command ?? args?.path ?? "")
        : (previous?.target ?? ""),
      state: started
        ? "running"
        : detail.cancelled
          ? "unknown"
          : detail.failed
            ? "failed"
            : "succeeded",
    });
    if (this.tools.size > 12)
      this.tools.delete(this.tools.keys().next().value!);
    this.refresh();
  }

  /** 表示用行を構築する（テストでも直接使えるよう公開）。 */
  lines(): TextChunk[][] {
    if (!this.busy) return [];
    const run = this.run;
    const active = [...this.tools.values(), ...this.checks.values()].filter(
      (item) => ["running", "failed", "unknown"].includes(item.state),
    );
    const lines = visibleItems(active, 2).map((item) =>
      activityLineChunks(item),
    );
    if (!lines.length && !this.previewing) {
      const task = run?.tasks.find((task) => task.state === "running");
      lines.push([
        theme.muted(
          task
            ? `${task.role === "reviewer" ? "レビュー中" : task.role === "lead" ? "計画中" : "応答を生成中"} · ${lineText(task.model ?? "選択中")}`
            : run
              ? runLabels[run.state]
              : "準備中…",
        ),
      ]);
    }
    // 旧実装の `render()` は末尾に空行を足していた（ツール行との視覚的分離）。
    return lines.length ? [...lines, []] : lines;
  }

  /** 状態を反映して content を更新する。 */
  refresh(): void {
    const lines = this.lines();
    const chunks: TextChunk[] = [];
    lines.forEach((line, i) => {
      if (i > 0) chunks.push({ __isChunk: true, text: "\n" });
      chunks.push(...line);
    });
    this.content = new StyledText(chunks);
  }
}

export { TextAttributes };
