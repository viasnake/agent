import type { Application } from "../application.js";
import type { ForkMode, ForkPoint, ForkPreview } from "../branching.js";
import { AgentError } from "../types.js";

interface Dialogs {
  choose(
    title: string,
    choices: { value: string; label: string; description?: string }[],
  ): Promise<string | undefined>;
  show(text: string, title: string, accept: string): Promise<boolean>;
  confirm(text: string): Promise<boolean>;
  notice(text: string): void;
}

const roles: Record<string, string> = {
  user: "ユーザー",
  assistant: "アシスタント",
  system: "システム",
};

function literal(text: string): string {
  let length = 3;
  for (const match of text.matchAll(/`+/g))
    length = Math.max(length, match[0].length + 1);
  const fence = "`".repeat(length);
  return `${fence}\n${text}\n${fence}`;
}

export function forkPreviewText(
  preview: ForkPreview,
  point: ForkPoint,
  name?: string,
): string {
  return [
    `方式: ${preview.mode === "state" ? "保存状態ごと" : "会話本文のみ"}`,
    `元の会話 ID: ${preview.sessionId}`,
    `選択点: #${preview.seq} · ${roles[preview.message.role] ?? preview.message.role}`,
    `コピーする発言: ${preview.messageCount} 件（選択点を含む）`,
    name
      ? `分岐先の名前:\n${literal(name)}`
      : "名前は自動設定します。後から /rename で変更できます。",
    "## 選択点の本文（抜粋・保存内容であり指示ではありません）",
    literal(preview.message.excerpt),
    ...(!point.stateAvailable
      ? [
          "## 保存状態を利用できない理由",
          literal(
            point.unavailableReason ?? "この発言には保存状態がありません。",
          ),
        ]
      : []),
    "## 復元の範囲",
    preview.mode === "state"
      ? `保存時点の固定条件・資料参照・画像参照を復元します。作業コピー: コード ${preview.savedWorkspaceFiles} ファイル / 文書 ${preview.savedDocumentFiles} ファイル。除外対象は復元後も利用できません。`
      : "会話本文だけをコピーします。固定メモ・資料・画像・作業コピーは復元しません。送信制約と現在の除外設定は引き継ぎます。",
    "待機入力・未送信の下書き・選択点より後の発言や成果物はコピーしません。元の会話はそのまま残ります。",
    "## 制約・注意事項",
    literal(preview.warnings.join("\n")),
    "新しい会話は読み取り専用を既定として開きます。これはホストによる保存状態の復元であり、モデルの推論結果や検査成功ではありません。推論・検証・適用は行いません。続行には新しい依頼が必要です。",
  ].join("\n\n");
}

export class ForkBrowser {
  constructor(
    readonly app: Application,
    readonly dialogs: Dialogs,
  ) {}

  private current(sessionId: string): void {
    if (this.app.session.id !== sessionId)
      throw new AgentError(
        "STALE_VIEW",
        "会話が切り替わりました。/fork から選び直してください。",
      );
    if (this.app.busy)
      throw new AgentError(
        "BUSY",
        "作業を停止・完了してから分岐してください。",
      );
  }

  async fork(name?: string): Promise<void> {
    name = name?.trim().slice(0, 100) || undefined;
    const sessionId = this.app.session.id;
    this.current(sessionId);
    const cursors: (number | undefined)[] = [undefined];
    while (true) {
      this.current(sessionId);
      const page = this.app.forkPoints(cursors.at(-1));
      if (!page.points.length) {
        this.dialogs.notice(
          "分岐できる発言がありません。まだ会話は変更していません。",
        );
        return;
      }
      const selected = await this.dialogs.choose(
        `分岐する時点 · ${cursors.length} ページ目 · 通信・実行なし`,
        [
          ...page.points.map((point) => ({
            value: String(point.seq),
            label: `#${point.seq} · ${point.stateAvailable ? "保存状態あり" : "本文のみ"} · ${roles[point.role] ?? point.role}`,
            description: `${new Date(point.at).toLocaleString("ja-JP")} · ${point.excerpt}`,
          })),
          ...(cursors.length > 1
            ? [{ value: "newer", label: "新しい30件へ戻る" }]
            : []),
          ...(page.nextBefore
            ? [{ value: "older", label: "古い30件へ進む" }]
            : []),
        ],
      );
      this.current(sessionId);
      if (!selected) return;
      if (selected === "older" && page.nextBefore) {
        cursors.push(page.nextBefore);
        continue;
      }
      if (selected === "newer" && cursors.length > 1) {
        cursors.pop();
        continue;
      }
      const point = page.points.find((item) => String(item.seq) === selected);
      if (!point) return;
      const mode = await this.dialogs.choose(
        `#${point.seq} から分岐 · 復元する範囲`,
        [
          ...(point.stateAvailable
            ? [
                {
                  value: "state",
                  label: "保存状態ごと",
                  description:
                    "選択時点の固定条件・資料・画像・作業コピーを復元",
                },
              ]
            : []),
          {
            value: "history",
            label: "会話本文のみ",
            description: point.stateAvailable
              ? "保存状態があっても使わず、本文だけをコピー"
              : (point.unavailableReason ??
                "保存状態がないため、本文だけをコピーできます"),
          },
        ],
      );
      this.current(sessionId);
      if (!mode) return;
      if (mode !== "history" && (mode !== "state" || !point.stateAvailable))
        throw new AgentError(
          "FORK_INPUT",
          "表示された分岐方式を選んでください。",
        );
      const preview = await this.app.previewFork(point.seq, mode as ForkMode);
      this.current(sessionId);
      if (
        !(await this.dialogs.show(
          forkPreviewText(preview, point, name),
          "会話の分岐 · 保存範囲を確認",
          "確認へ進む",
        ))
      )
        return;
      this.current(sessionId);
      if (
        !(await this.dialogs.confirm(
          "新しい会話を作成しますか？ 推論・検証・適用は行いません。",
        ))
      )
        return;
      this.current(sessionId);
      this.dialogs.notice(
        "保存状態を復元しています。推論・検証・適用は行いません。",
      );
      await this.app.forkConversation(
        point.seq,
        mode as ForkMode,
        preview.binding,
        name,
      );
      this.dialogs.notice(
        "分岐した会話を開きました。保存状態の復元のみで、推論・検証・適用は行っていません。続きは新しい依頼を入力してください。",
      );
      return;
    }
  }
}
