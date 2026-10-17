import type { Application } from "../application.js";
import type { HistoryDeletionPreview } from "../history-deletion.js";
import { AgentError } from "../types.js";
import { safeText } from "./components.js";

interface Dialogs {
  choose(
    title: string,
    choices: { value: string; label: string; description?: string }[],
  ): Promise<string | undefined>;
  show(text: string, title: string, accept: string): Promise<boolean>;
  confirm(text: string): Promise<boolean>;
  notice(text: string): void;
}

function literal(value: string): string {
  const text = safeText(value);
  let length = 3;
  for (const match of text.matchAll(/`+/g))
    length = Math.max(length, match[0].length + 1);
  const fence = "`".repeat(length);
  return `${fence}\n${text}\n${fence}`;
}

const warning =
  "共有画像・文書・チェックポイントのキャッシュ、SQLite の残存ページ、外部バックアップは削除しません。暗号学的消去は保証しません。稼働環境の停止・再開や推論は行いません。";

function canDelete(preview: HistoryDeletionPreview): boolean {
  return (
    !!(preview.conversationIds.length || preview.runIds.length) &&
    (preview.request.kind !== "selection" || !preview.retained.length)
  );
}

export function historyDeletionText(preview: HistoryDeletionPreview): string {
  return [
    canDelete(preview)
      ? "## 削除候補（まだ削除していません）"
      : "## 今回の選択は削除できません",
    `対象の作業場所:\n${literal(preview.request.workspace ?? "全作業ディレクトリ")}`,
    ...(preview.request.kind === "retention"
      ? [
          `保持期間の基準: ${new Date(preview.request.cutoff).toISOString()}（UTC）より前。自動削除ではありません。`,
          `今回の候補上限: 500 単位。上限により今回表示しない候補: ${preview.moreCandidates} 件（次回も参照確認します）。`,
        ]
      : [
          "選択に保持対象が一つでもあれば、選択全体を削除しません。対象を自動で増減しません。",
        ]),
    `削除可能な会話: ${preview.conversationIds.length} / 実行: ${preview.runIds.length}\n発言: ${preview.counts.messages} / 成果物: ${preview.counts.artifacts} / イベント: ${preview.counts.events}`,
    "会話を削除すると、保存された本文・下書き・待機入力と、その会話の全実行履歴・専用作業コピーを失います。先に /backup で保存することを勧めます。元の作業ディレクトリは削除しません。",
    `## 会話 ID\n${literal(preview.conversationIds.join("\n") || "なし")}`,
    `## 実行 ID（会話に属する実行も含む）\n${literal(preview.runIds.join("\n") || "なし")}`,
    "## 保持対象と理由",
    literal(
      preview.retained
        .map(
          (item) =>
            `${item.kind === "conversation" ? "会話" : "実行"}: ${item.name}\n${item.id}\n理由: ${item.reason}`,
        )
        .join("\n\n") || "なし",
    ),
    "メタデータを先に削除します。専用ファイルの削除に失敗した場合は保留ジョブを残し、/cleanup-deletions で明示的に再試行できます。確定後の中断では、既に削除した内容を元に戻せません。",
    warning,
  ].join("\n\n");
}

export class HistoryBrowser {
  constructor(
    readonly app: Application,
    readonly dialogs: Dialogs,
  ) {}

  private current(sessionId: string): void {
    if (this.app.busy || this.app.session.id !== sessionId)
      throw new AgentError(
        "STALE_VIEW",
        "会話・作業状態が変わりました。候補を選び直してください。",
      );
  }

  async remove(argument?: string): Promise<void> {
    const sessionId = this.app.session.id;
    this.current(sessionId);
    let conversationIds: string[] = [],
      runIds: string[] = [];
    if (argument?.trim()) {
      const ids = argument.trim().split(/\s+/);
      const kind =
        ids[0] === "run" || ids[0] === "session" ? ids.shift() : "session";
      if (!ids.length)
        throw new AgentError(
          "DELETE_REQUEST",
          "/delete [session|run] <ID...> の対象 ID を指定してください。",
        );
      if (kind === "run") runIds = ids;
      else conversationIds = ids;
    } else {
      const selected = new Set<string>();
      let offset = 0;
      while (true) {
        this.current(sessionId);
        const page = this.app.sessions(offset);
        const candidates = page.filter((session) => session.id !== sessionId);
        const choices = [
          ...candidates.map((session) => ({
            value: session.id,
            label: `${selected.has(session.id) ? "[選択済] " : ""}${safeText(session.name).replace(/\s+/g, " ").slice(0, 120)}`,
            description: `${session.id} · ${session.draft ? "下書きあり" : "下書きなし"} · 待機 ${session.queue.length} 件`,
          })),
          ...(selected.size
            ? [
                {
                  value: "preview",
                  label: `選択した ${selected.size} 件の削除候補を確認`,
                },
                { value: "clear", label: "選択をすべて解除" },
              ]
            : []),
          ...(offset ? [{ value: "newer", label: "新しい30件へ戻る" }] : []),
          ...(page.length === 30
            ? [{ value: "older", label: "古い30件へ進む" }]
            : []),
        ];
        if (!choices.length) {
          this.dialogs.notice(
            "この作業場所に削除候補の会話はありません。現在の会話は保護します。",
          );
          return;
        }
        const choice = await this.dialogs.choose(
          "会話の選択 · Enter で追加／解除 · Esc で取消",
          choices,
        );
        this.current(sessionId);
        if (!choice) return;
        if (choice === "preview" && selected.size) break;
        if (choice === "clear") {
          selected.clear();
          continue;
        }
        if (choice === "older" && page.length === 30) {
          offset += 30;
          continue;
        }
        if (choice === "newer" && offset) {
          offset -= 30;
          continue;
        }
        if (!candidates.some((session) => session.id === choice))
          throw new AgentError(
            "STALE_VIEW",
            "表示された会話から選び直してください。",
          );
        if (selected.has(choice)) selected.delete(choice);
        else if (selected.size < 500) selected.add(choice);
        else
          this.dialogs.notice(
            "一度に選べる会話は500件までです。選択を解除するか、候補確認へ進んでください。",
          );
      }
      conversationIds = [...selected];
    }
    this.current(sessionId);
    const preview = this.app.previewHistoryDeletion({
      kind: "selection",
      conversationIds,
      runIds,
    });
    await this.confirm(preview, sessionId);
  }

  async prune(): Promise<void> {
    const sessionId = this.app.session.id;
    this.current(sessionId);
    const preview = this.app.previewHistoryDeletion({
      kind: "retention",
      cutoff: Date.now() - this.app.config.retentionDays * 86_400_000,
    });
    await this.confirm(preview, sessionId);
  }

  private async confirm(
    preview: HistoryDeletionPreview,
    sessionId: string,
  ): Promise<void> {
    const eligible = canDelete(preview);
    const accepted = await this.dialogs.show(
      historyDeletionText(preview),
      "履歴削除 · 対象と保持理由",
      eligible ? "最終確認へ進む" : "",
    );
    this.current(sessionId);
    if (!eligible || !accepted) return;
    if (
      !(await this.dialogs.confirm(
        `会話 ${preview.conversationIds.length} 件・実行 ${preview.runIds.length} 件を削除しますか？ 下書き・待機入力・専用作業コピーも失われ、この操作は元に戻せません。`,
      ))
    )
      return;
    this.current(sessionId);
    const result = await this.app.confirmHistoryDeletion(preview);
    this.dialogs.notice(
      `会話 ${result.removedConversations.length} 件・実行 ${result.removedRuns.length} 件のメタデータを削除しました。` +
        (result.pendingCleanup.length
          ? ` ファイル回収は保留です。/cleanup-deletions で確認・再試行: ${result.pendingCleanup.map((job) => job.id).join(", ")}`
          : " 専用ファイルの回収も完了しました。") +
        " 共有キャッシュ・外部コピーは残り、暗号学的消去は保証しません。",
    );
  }

  async cleanup(): Promise<void> {
    const sessionId = this.app.session.id;
    let offset = 0;
    while (true) {
      this.current(sessionId);
      const jobs = this.app.pendingHistoryDeletions();
      if (!jobs.length) {
        this.dialogs.notice("ファイル削除の保留ジョブはありません。");
        return;
      }
      offset = Math.min(offset, Math.floor((jobs.length - 1) / 30) * 30);
      const page = jobs.slice(offset, offset + 30);
      const choice = await this.dialogs.choose(
        "削除保留ジョブ · 全作業ディレクトリ · 一件ずつ明示再試行",
        [
          ...page.map((job) => ({
            value: job.id,
            label: `${job.id} · 実行 ${job.runIds.length} 件`,
            description: safeText(job.error ?? "未回収の専用ファイル"),
          })),
          ...(offset ? [{ value: "previous", label: "前の30件" }] : []),
          ...(offset + 30 < jobs.length
            ? [{ value: "next", label: "次の30件" }]
            : []),
        ],
      );
      this.current(sessionId);
      if (!choice) return;
      if (choice === "next" && offset + 30 < jobs.length) {
        offset += 30;
        continue;
      }
      if (choice === "previous" && offset) {
        offset -= 30;
        continue;
      }
      if (!page.some((job) => job.id === choice))
        throw new AgentError(
          "STALE_VIEW",
          "表示されたジョブから選び直してください。",
        );
      const preview = this.app.previewHistoryCleanup([choice]);
      const text = [
        "## 削除済み履歴のファイル回収を再試行",
        "対象は全作業ディレクトリにある保留ジョブのうち、以下の一件だけです。新たな会話や実行のメタデータは削除しません。",
        ...preview.jobs.map((job) =>
          literal(
            `ジョブ: ${job.id}\n対象の実行 ID:\n${job.runIds.join("\n")}\n前回のエラー: ${job.error ?? "なし"}`,
          ),
        ),
        "ディレクトリが置き換わった場合や実行 ID が再使用された場合は回収しません。再試行しなくても自動では回収されません。",
        warning,
      ].join("\n\n");
      if (
        !(await this.dialogs.show(
          text,
          "保留ジョブ · 回収対象",
          "最終確認へ進む",
        ))
      )
        return;
      this.current(sessionId);
      if (
        !(await this.dialogs.confirm(
          "このジョブの専用ファイル回収を再試行しますか？ 既に回収したファイルは元に戻せません。",
        ))
      )
        return;
      this.current(sessionId);
      const remaining = await this.app.confirmHistoryCleanup(preview);
      this.dialogs.notice(
        remaining.length
          ? `ファイル回収は引き続き保留です。${remaining.map((job) => `${job.id}: ${safeText(job.error ?? "未回収")}`).join(" / ")}`
          : "選択したジョブの専用ファイル回収が完了しました。共有キャッシュ・外部コピーの削除や暗号学的消去は行っていません。",
      );
      return;
    }
  }

  async cacheCleanup(): Promise<void> {
    const sessionId = this.app.session.id;
    this.current(sessionId);
    const preview = await this.app.previewCacheCleanup();
    const text = [
      "## 共有キャッシュ削除候補（まだ削除していません）",
      `対象: ${preview.selected.length} 件、超過候補: ${preview.moreCandidates} 件`,
      ...preview.selected.map(
        (item) => `${literal(item.path)} (${item.bytes} bytes)`,
      ),
      ...preview.retained.map(
        (item) => `保持: ${literal(item.path)}\n理由: ${safeText(item.reason)}`,
      ),
      "24時間未満、参照中、稼働プロセスの pin は保持します。バックアップ・SQLite残存ページ・外部コピーの暗号学的消去は保証しません。",
    ].join("\n\n");
    if (
      !(await this.dialogs.show(
        text,
        "共有キャッシュ · 候補",
        "最終確認へ進む",
      ))
    )
      return;
    this.current(sessionId);
    if (
      !(await this.dialogs.confirm(
        "表示された共有キャッシュを明示的に削除しますか？",
      ))
    )
      return;
    this.current(sessionId);
    const result = await this.app.confirmCacheCleanup(preview);
    this.dialogs.notice(
      result.pending.length
        ? `共有キャッシュの一部を保留しました。${result.pending.map((job) => job.id).join(", ")}`
        : "共有キャッシュの削除が完了しました。暗号学的消去は保証しません。",
    );
  }
}
