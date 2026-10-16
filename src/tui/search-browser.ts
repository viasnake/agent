import type { Application } from "../application.js";
import { AgentError } from "../types.js";
import type { SearchHit, SearchKind } from "../search.js";

interface Dialogs {
  choose(
    title: string,
    choices: { value: string; label: string; description?: string }[],
  ): Promise<string | undefined>;
  show(text: string, title?: string): Promise<boolean>;
  notice(text: string): void;
}

function literal(text: string): string {
  let length = 3;
  for (const match of text.matchAll(/`+/g))
    length = Math.max(length, match[0].length + 1);
  const fence = "`".repeat(length);
  return `${fence}\n${text}\n${fence}`;
}

export class SearchBrowser {
  constructor(
    readonly app: Application,
    readonly dialogs: Dialogs,
  ) {}

  async search(text: string): Promise<void> {
    if (this.app.busy)
      throw new AgentError(
        "BUSY",
        "作業が停止・完了してから検索してください。",
      );
    const sessionId = this.app.session.id;
    const kind = (await this.dialogs.choose(
      "ローカル履歴を文字列で検索 · 通信なし",
      [
        { value: "conversations", label: "会話名" },
        { value: "runs", label: "依頼・担当タスク" },
        { value: "messages", label: "会話の本文" },
        { value: "events", label: "実行イベント" },
        { value: "artifacts", label: "保存済み資料・成果物の名前と本文" },
        { value: "files", label: "現在の作業コピーのファイル名と本文" },
      ],
    )) as SearchKind | undefined;
    if (!kind) return;
    const scope =
      kind === "files"
        ? "current"
        : await this.dialogs.choose("検索範囲 · 他プロジェクトは含めません", [
            { value: "current", label: "現在の会話" },
            {
              value: "workspace",
              label: "この作業ディレクトリの過去の会話も含む",
            },
          ]);
    if (!scope) return;
    let cursor: string | undefined;
    while (true) {
      if (this.app.session.id !== sessionId)
        throw new AgentError(
          "STALE_VIEW",
          "会話が切り替わりました。検索し直してください。",
        );
      const page = await this.app.search({
        kind,
        text,
        cursor,
        conversationId: scope === "current" ? sessionId : undefined,
        runId:
          kind === "files"
            ? (this.app.session.workRunId ?? this.app.session.latestRunId)
            : undefined,
      });
      const warning = page.warnings.join(" / ");
      if (!page.hits.length && !page.cursor) {
        this.dialogs.notice(
          `この検索ページに一致はありません。${warning ? ` ${warning}` : ""}`,
        );
        return;
      }
      const choice = await this.dialogs.choose(
        `ローカル検索 · このページ ${page.hits.length} 件 · ${page.scanned} 候補を確認`,
        [
          ...page.hits.map((hit, index) => ({
            value: String(index),
            label: hit.label,
            description: `${hit.conversationId}${hit.line ? ` · L${hit.line}` : ""} · ${hit.excerpt}`,
          })),
          ...(page.cursor
            ? [{ value: "next", label: "続きを検索する（未検索の候補あり）" }]
            : []),
          ...(warning
            ? [
                {
                  value: "limits",
                  label: "検索の制限・省略を確認",
                  description: warning,
                },
              ]
            : []),
        ],
      );
      if (!choice) return;
      if (choice === "limits") {
        await this.dialogs.show(literal(warning), "検索範囲・省略の記録");
        continue;
      }
      if (choice === "next") {
        cursor = page.cursor;
        continue;
      }
      const hit: SearchHit | undefined = page.hits[Number(choice)];
      if (!hit) return;
      const action = await this.dialogs.choose(hit.label, [
        { value: "read", label: "保存内容を読む（変更・送信しません）" },
        ...(hit.conversationId !== sessionId
          ? [{ value: "open", label: "この会話を開く（実行は再開しません）" }]
          : []),
      ]);
      if (action === "read") {
        const result = await this.app.readSearchResult(hit);
        await this.dialogs.show(
          "ローカルの保存内容です。今後の送信から除外した原本・過去の発言も履歴には残ります。検索・閲覧はモデルへの入力追加や外部通信を行いません。\n\n" +
            literal(result.text),
          result.title,
        );
      } else if (action === "open") {
        this.app.openSession(hit.conversationId);
        return;
      } else return;
    }
  }
}
