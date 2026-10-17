import { resolve } from "node:path";
import type { Application } from "../application.js";
import {
  backupReadWarning,
  extractBackupFile,
  previewBackupExtract,
  readBackup,
  type BackupPage,
  type BackupSelection,
} from "../backup-reader.js";
import { AgentError } from "../types.js";
import { commandPath } from "./actions.js";
import { safeText } from "./components.js";

interface Dialogs {
  prompt(title: string): Promise<string | undefined>;
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
  const fence = "`".repeat(
    Math.max(
      3,
      ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1),
    ),
  );
  return `${fence}\n${text}\n${fence}`;
}
export function backupReadText(page: BackupPage): string {
  return [
    backupReadWarning,
    literal(JSON.stringify(page.detail ?? {}, null, 2)),
    ...(page.text === undefined
      ? ["バイナリの本文は表示しません。書出後のファイルも自動では開きません。"]
      : [
          `本文位置: ${page.offset}（UTF-16）${page.nextOffset === undefined ? " · 末尾" : " · 続きあり"}`,
          literal(page.text),
        ]),
  ].join("\n\n");
}
export class BackupReaderBrowser {
  constructor(
    readonly app: Application,
    readonly dialogs: Dialogs,
  ) {}

  async open(argument?: string): Promise<void> {
    const sessionId = this.app.session.id;
    const current = () => {
      if (this.app.busy || this.app.session.id !== sessionId)
        throw new AgentError(
          "STALE_VIEW",
          "会話・作業状態が変わりました。/backup-open から選び直してください。",
        );
    };
    current();
    const input =
      argument ||
      (await this.dialogs.prompt(
        "保存済みバックアップのディレクトリ（読取専用）",
      ));
    current();
    if (!input?.trim()) return;
    const archive = resolve(this.app.workspace, commandPath(input));
    if (
      !(await this.dialogs.show(
        backupReadWarning,
        "非公開のバックアップを開く",
        "ローカルで閲覧",
      ))
    )
      return;
    current();
    const roots = [this.app.paths.home, this.app.workspace];
    let binding: string | undefined;
    const stack: BackupSelection[] = [];
    while (true) {
      current();
      if (!stack.length) {
        const kind = await this.dialogs.choose("バックアップ · 読み戻す対象", [
          { value: "conversations", label: "保存済み会話" },
          { value: "runs", label: "実行・成果物・出典" },
          { value: "files", label: "全保存ファイル・設定・画像・資料" },
        ]);
        current();
        if (!kind) return;
        if (kind !== "conversations" && kind !== "runs" && kind !== "files")
          throw new AgentError(
            "STALE_VIEW",
            "表示された対象から選んでください。",
          );
        stack.push({ kind });
      }
      const selected = stack.at(-1)!;
      const page = readBackup(archive, selected);
      if (binding && page.binding !== binding)
        throw new AgentError(
          "STALE_VIEW",
          "バックアップが変化しました。開き直してください。",
        );
      binding = page.binding;
      if (selected.kind === "message" || selected.kind === "file") {
        const accepted = await this.dialogs.show(
          backupReadText(page),
          "バックアップ · 保存済み本文",
          "操作を選ぶ",
        );
        current();
        if (!accepted) {
          stack.pop();
          continue;
        }
        const action = await this.dialogs.choose(
          "保存済み本文 · 自動取込なし",
          [
            ...(page.nextOffset === undefined
              ? []
              : [{ value: "next", label: "次の部分" }]),
            ...(page.offset ? [{ value: "first", label: "先頭へ戻る" }] : []),
            ...(selected.kind === "file"
              ? [
                  {
                    value: "extract",
                    label:
                      "このファイルの全バイトを書き出す（新規ファイルのみ）",
                  },
                ]
              : []),
            { value: "back", label: "一覧へ戻る" },
          ],
        );
        current();
        if (action === "next" && page.nextOffset !== undefined)
          selected.offset = page.nextOffset;
        else if (action === "first") selected.offset = 0;
        else if (action === "extract" && selected.kind === "file") {
          const output = await this.dialogs.prompt(
            "書出先の新しいファイル（Agent領域・作業領域・アーカイブの外）",
          );
          current();
          if (!output?.trim()) continue;
          const preview = previewBackupExtract(
            archive,
            selected.path,
            resolve(this.app.workspace, commandPath(output)),
            roots,
          );
          if (preview.archiveBinding !== binding)
            throw new AgentError(
              "STALE_VIEW",
              "バックアップが変化しました。開き直してください。",
            );
          if (
            !(await this.dialogs.show(
              [
                backupReadWarning,
                literal(JSON.stringify(preview, null, 2)),
                "ファイル全体を 0600 で新規保存します。上書き・自動実行・設定反映はしません。",
              ].join("\n\n"),
              "書出範囲の確認",
              "確認へ進む",
            ))
          )
            continue;
          current();
          if (
            !(await this.dialogs.confirm(
              "非公開の保存済みファイルを書き出しますか？",
            ))
          )
            continue;
          current();
          extractBackupFile(preview, roots);
          this.dialogs.notice(
            `${preview.bytes} bytes を新規保存しました。会話・設定の取込や実行はしていません。`,
          );
        } else stack.pop();
        continue;
      }
      const choice = await this.dialogs.choose(
        `バックアップ · ${page.kind} · ${page.offset + 1}件目から`,
        [
          ...page.items.map((item, index) => ({
            value: `item:${index}`,
            label: safeText(
              String(
                item.name ??
                  item.objective ??
                  item.path ??
                  item.preview ??
                  item.id ??
                  item.seq,
              ),
            )
              .replace(/\s+/g, " ")
              .slice(0, 120),
            description: safeText(
              String(item.id ?? item.seq ?? item.bytes ?? ""),
            ),
          })),
          ...(page.nextOffset === undefined
            ? []
            : [{ value: "next", label: "次の30件" }]),
          ...(page.offset ? [{ value: "previous", label: "前の30件" }] : []),
          { value: "back", label: "戻る" },
        ],
      );
      current();
      if (!choice || choice === "back") {
        stack.pop();
        continue;
      }
      if (choice === "next" && page.nextOffset !== undefined) {
        selected.offset = page.nextOffset;
        continue;
      }
      if (choice === "previous" && page.offset) {
        selected.offset = Math.max(0, page.offset - 30);
        continue;
      }
      const index = /^item:(\d+)$/.exec(choice)?.[1];
      const item = index === undefined ? undefined : page.items[Number(index)];
      if (!item)
        throw new AgentError(
          "STALE_VIEW",
          "表示された項目から選んでください。",
        );
      if (selected.kind === "conversations")
        stack.push({ kind: "conversation", id: String(item.id) });
      else if (selected.kind === "runs")
        stack.push({ kind: "run", id: String(item.id) });
      else if (selected.kind === "conversation")
        stack.push({ kind: "message", id: selected.id, seq: Number(item.seq) });
      else stack.push({ kind: "file", path: String(item.path) });
    }
  }
}
