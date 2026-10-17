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

export class ConversationView implements Component {
  name = "新しい会話";
  workspace = process.cwd();
  setup: string[] = [];
  recent = "";
  hasOlder = false;
  private messages: {
    seq: number;
    source: string;
    role: string;
    body: Markdown;
    limit: number;
  }[] = [];
  setMessages(messages: ConversationMessage[]): void {
    // Streaming updates do not rebuild unchanged Markdown components.
    const previousMessages = new Map(
      this.messages.map((message) => [message.seq, message]),
    );
    this.messages = messages.map((message) => {
      const previous = previousMessages.get(message.seq);
      if (previous?.source === message.text && previous.role === message.role)
        return previous;
      return {
        seq: message.seq,
        source: message.text,
        role: message.role,
        limit: 6000,
        body: markdown(excerpt(message.text, 6000)),
      };
    });
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
    message.body = markdown(excerpt(message.source, message.limit));
    return true;
  }
  invalidate(): void {
    for (const message of this.messages) message.body.invalidate();
  }
  render(width: number): string[] {
    const fit = (text: string) => truncateToWidth(text, width);
    const lines = [
      fit(
        `${theme.strong(lineText(this.name))}  ${theme.muted("/ " + lineText(basename(this.workspace)))}`,
      ),
      theme.muted("─".repeat(width)),
    ];
    if (!this.messages.length)
      return [
        ...lines,
        "",
        ...this.setup.flatMap((line) => new Text(line, 0, 0).render(width)),
        ...(this.recent
          ? ["", ...new Text(this.recent, 0, 0).render(width)]
          : []),
        "",
      ];
    if (this.hasOlder)
      lines.push(fit(theme.muted("↑ スクロールで以前の発言を読込 · /history")));
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
        ...(Buffer.byteLength(message.source) > message.limit
          ? [fit(theme.muted(`… /expand ${message.seq} で続きを表示`))]
          : []),
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
