import {
  truncateToWidth,
  Text,
  type Component,
  type Markdown,
} from "@earendil-works/pi-tui";
import type { ConversationMessage } from "../conversations.js";
import { basename } from "node:path";
import type { Role, Run, RunState } from "../types.js";
import { markdown, safeText, theme } from "./components.js";

const lineText = (text: string) => safeText(text).replace(/\s+/g, " ");
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
    "\n担当",
    ...run.tasks.map((task) =>
      [
        `${activityLabels[task.state]} / ${roles[task.role]} / ${task.id}`,
        `モデル: ${task.model ?? "選択前"} · 試行 ${task.attempts}`,
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
        "",
      ].join("\n"),
    ),
  ].join("\n");
}

export class ConversationView implements Component {
  name = "新しい会話";
  workspace = process.cwd();
  setup: string[] = [];
  recent = "";
  private messages: { source: string; role: string; body: Markdown }[] = [];
  setMessages(messages: ConversationMessage[]): void {
    // Streaming updates do not rebuild unchanged Markdown components.
    this.messages = messages.slice(-8).map((message, index) => {
      const previous = this.messages[index];
      if (previous?.source === message.text && previous.role === message.role)
        return previous;
      return {
        source: message.text,
        role: message.role,
        body: markdown(
          Buffer.byteLength(message.text) > 6000
            ? `長いメッセージ (${Buffer.byteLength(message.text)} bytes) — /history で全文を表示`
            : message.text,
        ),
      };
    });
  }
  invalidate(): void {
    for (const message of this.messages) message.body.invalidate();
  }
  render(width: number): string[] {
    const fit = (text: string) => truncateToWidth(text, width);
    const lines = [
      "",
      fit(
        `${theme.accent("▰")} ${theme.strong("LOCAL AGENT")}  ${theme.muted("/  " + lineText(basename(this.workspace)))}`,
      ),
      fit(
        `${theme.strong(lineText(this.name))}  ${theme.muted("· 作業コピーで検査 → 確認して適用")}`,
      ),
      theme.muted("─".repeat(width)),
    ];
    if (!this.messages.length)
      return [
        ...lines,
        "",
        "",
        fit(theme.strong("何をつくりますか？")),
        ...new Text(
          "コードの変更も、調査も、レビューも。この会話から。",
          0,
          0,
        ).render(width),
        "",
        ...this.setup.flatMap((line) => new Text(line, 0, 0).render(width)),
        ...(this.recent
          ? ["", ...new Text(this.recent, 0, 0).render(width)]
          : []),
        "",
        fit(
          `${theme.accent("/settings")} 接続を設定   ${theme.accent("/sessions")} 会話を開く`,
        ),
        fit(theme.muted("@ ファイルを添付   Ctrl+P すべての操作")),
        "",
      ];
    for (const message of this.messages) {
      const body = message.body.render(Math.max(1, width - 2));
      lines.push(
        "",
        fit(
          message.role === "user"
            ? theme.accent("あなた")
            : theme.strong("AGENT"),
        ),
        ...body.map((line) => {
          const prefix = message.role === "user" ? "▎ " : "  ";
          const content = prefix + line;
          return message.role === "user"
            ? theme.panel(truncateToWidth(content, width, "", true))
            : content;
        }),
      );
    }
    return [...lines, ""];
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
function activityLine(item: ActivityItem, width: number): string {
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
  // State precedes potentially long model names, commands and paths so a narrow
  // terminal never hides whether a tool actually ran or is still pending.
  return truncateToWidth(
    `${style(`${marker} ${activityLabels[item.state]}`)}  ${lineText(item.label)}${item.target ? theme.muted(` · ${lineText(item.target)}`) : ""}`,
    width,
  );
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

export class ActivityView implements Component {
  run?: Pick<Run, "state" | "tasks">;
  busy = false;
  previewing = false;
  readonly tools = new Map<string, ActivityItem>();
  readonly checks = new Map<string, ActivityItem>();
  clear(): void {
    this.tools.clear();
    this.checks.clear();
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
  }
  invalidate(): void {}
  render(width: number): string[] {
    if (!this.busy) return [];
    const run = this.run;
    const active = [...this.tools.values(), ...this.checks.values()].filter(
      (item) => ["running", "failed", "unknown"].includes(item.state),
    );
    const lines = visibleItems(active, 2).map((item) =>
      activityLine(item, width),
    );
    if (!lines.length && !this.previewing) {
      const task = run?.tasks.find((task) => task.state === "running");
      lines.push(
        truncateToWidth(
          theme.muted(
            task
              ? `${task.role === "reviewer" ? "レビュー中" : task.role === "lead" ? "計画中" : "応答を生成中"} · ${lineText(task.model ?? "選択中")}`
              : run
                ? runLabels[run.state]
                : "準備中…",
          ),
          width,
        ),
      );
    }
    return lines.length ? [...lines, ""] : [];
  }
}
