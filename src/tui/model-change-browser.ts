import type {
  Application,
  ApplicationModelChangePreview,
} from "../application.js";
import { AgentError, type Run } from "../types.js";
import { safeText } from "./components.js";
import { excerpt, runLabels } from "./workbench.js";

interface Dialogs {
  choose(
    title: string,
    choices: { value: string; label: string; description?: string }[],
  ): Promise<string | undefined>;
  show(text: string, title: string, accept: string): Promise<boolean>;
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

export function modelChangePreviewText(
  preview: ApplicationModelChangePreview,
): string {
  const destination = preview.destination;
  return [
    "## 待機中の担当だけを変更",
    literal(
      `実行: ${preview.runId}\n担当: ${preview.taskId}\n現在: ${preview.fromModel}\n切替先: ${preview.toModel}\nモデル ID: ${destination.modelId}\n接続: ${destination.connection} / ${destination.type}\n送信先: ${destination.endpoint ?? "プロバイダー標準の接続先"}\n課金区分: ${destination.billing}`,
    ),
    "この操作では推論・疎通試験・適用を行いません。/model の「次の依頼から」の設定は変更しません。",
    "## 影響する担当",
    literal(
      preview.tasks
        .filter((task) => task.affected)
        .map((task) =>
          task.id === preview.taskId
            ? `${task.id}: ${task.model} → ${preview.toModel}（結果を再取得）`
            : `${task.id}: ${task.model ?? "未選択"}（モデルは変更せず結果を再取得）`,
        )
        .join("\n"),
    ),
    "上記の結果と継続用セッションを無効化します。旧結果・報告・修正履歴は削除せず保存し、依存しない担当の結果は保持します。他の担当が同じ接続先を使っていても、自動で切り替えません。",
    "## 維持する制約と予算",
    literal(
      `データ分類: ${preview.dataClass}\nローカル限定: ${preview.localOnly ? "有効" : "無効（現在の許可範囲を維持）"}\n権限: ${preview.access === "read-only" ? "読み取り専用" : "変更あり"}\n必須検査: ${preview.preservedChecks.join(", ") || "指定なし"}\n資料除外: ID ${preview.sourceExclusions.ids.length} / hash ${preview.sourceExclusions.hashes.length} / URL ${preview.sourceExclusions.urls.length}\n画像除外: ${preview.redactedImageIds.length}\n使用済み要求: ${preview.usage.requests}\n残り要求: ${preview.remainingRequests}（必要最少 ${preview.minimumRequests}）\n既知費用: ${preview.usage.knownCostUsd} USD / 費用不明: ${preview.usage.unknownCostRequests} 件\n保留予約: ${preview.usage.heldUsd} USD / 残り API 予算: ${preview.remainingApiUsd} USD\n残り時間（保存時点）: ${preview.remainingSeconds.toFixed(1)} 秒`,
    ),
    "固定条件・資料の許可範囲・必須検査は維持し、利用量・時間・修正回数をリセットしません。",
    "## 確定後も待機します",
    "再開は別途 /resume で明示してください。変更ありの作業では必須検査をやり直します。読み取り専用の実行記録は検査合格を意味しません。切替前後の意味的な同等性・品質は未確認です。",
  ].join("\n\n");
}

export class ModelChangeBrowser {
  constructor(
    readonly app: Application,
    readonly dialogs: Dialogs,
  ) {}

  private current(sessionId: string, runId: string, generation: number): Run {
    const run = this.app.currentRun();
    if (
      this.app.session.id !== sessionId ||
      !run ||
      run.id !== runId ||
      run.generation !== generation
    )
      throw new AgentError(
        "STALE_VIEW",
        "作業が変わりました。/model-change から選び直してください。",
      );
    if (this.app.busy)
      throw new AgentError(
        "BUSY",
        "実行中のモデルは変更できません。停止してから選び直してください。",
      );
    if (
      !["waiting_input", "waiting_quota", "waiting_approval"].includes(
        run.state,
      )
    )
      throw new AgentError(
        "MODEL_CHANGE_STATE",
        "モデル切替は待機中の作業だけが対象です。完了・失敗・中断した作業は新しい依頼で続けてください。",
      );
    return run;
  }

  async change(taskId?: string): Promise<void> {
    const run = this.app.currentRun();
    if (!run) {
      this.dialogs.notice(
        "待機中の作業はありません。次の依頼のモデルは /model で選択できます。",
      );
      return;
    }
    const sessionId = this.app.session.id;
    const current = () => this.current(sessionId, run.id, run.generation);
    current();
    const tasks = run.tasks.filter((task) => task.model);
    if (!tasks.length) {
      this.dialogs.notice(
        "モデルが選択済みの担当はありません。/tasks で状態を確認してください。",
      );
      return;
    }
    taskId ??= await this.dialogs.choose(
      `モデル切替 · ${runLabels[run.state]}`,
      tasks.map((task) => ({
        value: task.id,
        label: `${task.id} · ${task.model}${task.purpose === "synthesis" ? " · 最終統合" : task.role === "reviewer" ? " · 独立レビュー" : task.delegatedBy ? " · 委任先" : ""}`,
        description: safeText(excerpt(task.objective, 240)).replace(
          /\s+/g,
          " ",
        ),
      })),
    );
    current();
    if (!taskId) return;
    if (!tasks.some((task) => task.id === taskId))
      throw new AgentError("TASK", "表示された担当 ID を選んでください。");
    const candidates = this.app.taskModelCandidates(taskId);
    if (!candidates.length) {
      this.dialogs.notice(
        "許可された別モデルがありません。能力・送信制約・独立レビュー条件は緩めません。",
      );
      return;
    }
    const model = await this.dialogs.choose(
      "切替先 · 許可条件に合う別モデル",
      candidates.map((candidate) => ({
        value: candidate.alias,
        label: candidate.alias,
        description: `${candidate.connection} / ${candidate.modelId} · ${candidate.localOnly ? "ローカル" : "外部接続"} · ${candidate.billing}`,
      })),
    );
    current();
    if (!model) return;
    if (!candidates.some((candidate) => candidate.alias === model))
      throw new AgentError(
        "NO_MODEL",
        "表示された候補モデルを選んでください。",
      );
    const preview = this.app.previewTaskModelChange(taskId, model);
    if (
      !(await this.dialogs.show(
        modelChangePreviewText(preview),
        "モデル切替 · 影響を確認",
        "確認へ進む",
      ))
    )
      return;
    current();
    if (
      !(await this.dialogs.confirm(
        "選択した担当のモデルを変更しますか？ 旧結果は保存し、再開はしません。",
      ))
    )
      return;
    current();
    await this.app.confirmTaskModelChange(preview);
    this.dialogs.notice(
      "モデルを変更しました。まだ推論・検査・適用は行っていません。/tasks で確認し、/resume で明示再開してください。",
    );
  }
}
