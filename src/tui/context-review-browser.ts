import type {
  Application,
  ApplicationContextReviewPreview,
} from "../application.js";
import { AgentError } from "../types.js";
import { safeText } from "./components.js";

interface Dialogs {
  show(text: string, title: string, accept: string): Promise<boolean>;
  prompt(title: string, initial: string): Promise<string | undefined>;
  confirm(text: string): Promise<boolean>;
  notice(text: string): void;
}

function literal(text: string): string {
  text = safeText(text);
  let length = 3;
  for (const match of text.matchAll(/`+/g))
    length = Math.max(length, match[0].length + 1);
  const fence = "`".repeat(length);
  return `${fence}\n${text}\n${fence}`;
}

export function contextReviewPreviewText(
  preview: ApplicationContextReviewPreview,
): string {
  const kinds = {
    missing_condition: "条件の見落とし",
    contradiction: "矛盾の疑い",
    repeated_exploration: "調査の反復",
  };
  return [
    "## コンテキストの確認待ち",
    "ホストの反復検知は推定、モデルの申告は未検証です。意味的な矛盾の網羅的検出や、圧縮が原因であることの証明ではありません。",
    literal(`実行: ${preview.runId}\n確認対象: ${preview.binding}`),
    ...preview.issues.map((issue) =>
      literal(
        [
          `検知 ID: ${issue.id} / 担当: ${issue.taskId}`,
          `種別: ${kinds[issue.kind]}`,
          `報告元: ${issue.origin === "model" ? "モデル申告（未検証）" : "ホスト検知（反復の推定）"}`,
          `内容:\n${issue.detail}`,
          `根拠・申告された引用:\n${issue.evidence}`,
          `資料 ID: ${issue.sourceIds.join(", ") || "なし"}`,
          `アーカイブ ID: ${issue.archiveIds.join(", ") || "なし"}`,
          `操作 ID: ${issue.operationIds.join(", ") || "なし"}`,
        ].join("\n\n"),
      ),
    ),
    "## 保持する実行条件と利用量",
    literal(JSON.stringify(preview.policy, null, 2)),
    "確認しても、固定条件・送信制約・権限・検査は変更しません。使用済み利用量・費用・時間はリセットしません。確認済みの待機担当に再試行の機会を1回追加しますが、実行全体の上限は維持します。",
    "確認メモは監査記録であり、新しい実行指示ではありません。条件を修正する場合は、確認後に新しい依頼として送ってください。",
    "## 確認後も自動実行しません",
    "推論・ツール・検査・適用は開始しません。待機入力と下書きは保持します。同じ作業の再開は別途 /resume、終了した作業の続きは新しい依頼で明示してください。",
  ].join("\n\n");
}

export class ContextReviewBrowser {
  constructor(
    readonly app: Application,
    readonly dialogs: Dialogs,
  ) {}

  private current(preview: ApplicationContextReviewPreview): void {
    const fresh = this.app.previewContextReview(preview.runId);
    if (
      fresh.binding !== preview.binding ||
      fresh.appBinding !== preview.appBinding
    )
      throw new AgentError(
        "CONTEXT_REVIEW_STALE",
        "確認対象が変わりました。/context-review から確認し直してください。",
      );
  }

  async review(): Promise<void> {
    const run = this.app.currentRun();
    if (!run?.contextIssues?.some((issue) => !issue.acknowledged)) {
      this.dialogs.notice("確認待ちのコンテキスト検知はありません。");
      return;
    }
    const preview = this.app.previewContextReview();
    if (
      !(await this.dialogs.show(
        contextReviewPreviewText(preview),
        "コンテキスト · 検知内容と根拠",
        "確認メモへ",
      ))
    )
      return;
    this.current(preview);
    const note = await this.dialogs.prompt(
      "確認メモ（条件変更ではありません・2,000 bytes 以内）",
      "",
    );
    if (note === undefined) return;
    if (!note.trim() || Buffer.byteLength(note) > 2000)
      throw new AgentError(
        "CONTEXT_REVIEW",
        "空でない確認メモを2,000 bytes以内で入力してください。何も変更していません。",
      );
    this.current(preview);
    if (
      !(await this.dialogs.show(
        [
          "## 記録する確認メモ",
          literal(note),
          "これは確認したという記録だけです。検知の正しさや問題の解消を保証せず、実行条件・権限は変更しません。推論や待機入力の実行も開始しません。",
        ].join("\n\n"),
        "コンテキスト · 確認メモ",
        "確定確認へ",
      ))
    )
      return;
    this.current(preview);
    if (
      !(await this.dialogs.confirm(
        "確認済みとして記録しますか？ 推論・再開・条件変更はしません。",
      ))
    )
      return;
    this.app.confirmContextReview(preview, note);
    this.dialogs.notice(
      "確認を記録しました。再開・待機入力の実行・適用はしていません。同じ作業は /resume、条件の修正は新しい依頼で明示してください。",
    );
  }
}
