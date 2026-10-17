import { resolve } from "node:path";
import type { Application } from "../application.js";
import { backupExclusions, type BackupPreview } from "../backup.js";
import { AgentError } from "../types.js";
import { commandPath } from "./actions.js";
import { safeText } from "./components.js";

interface Dialogs {
  prompt(title: string): Promise<string | undefined>;
  show(text: string, title: string, accept: string): Promise<boolean>;
  confirm(text: string): Promise<boolean>;
  notice(text: string): void;
}
export function backupPreviewText(preview: BackupPreview): string {
  const target = safeText(preview.destination);
  const length = Math.max(
    3,
    ...[...target.matchAll(/`+/g)].map((match) => match[0].length + 1),
  );
  const fence = "`".repeat(length);
  return [
    "## 全作業ディレクトリの履歴を非公開保存",
    `保存先:\n${fence}\n${target}\n${fence}`,
    `会話: ${preview.conversations} / 実行: ${preview.runs}\nファイル: ${preview.files}（完了記録を除く）\n見積: ${preview.estimatedBytes} bytes（DBの未使用領域を含み、完了記録を除く）`,
    "会話・待機入力・下書き・設定・保存済み出典と成果物・参照中の画像と資料・保存済み作業境界を含みます。現在の会話だけではありません。",
    "## 含めないもの",
    ...backupExclusions.map((value) => `- ${value}`),
    "## 共有用の診断ではありません",
    "非公開・restricted の本文と、過去に除外した資料も含みます。資格情報ストアは含めませんが、本文や設定に手入力した秘密は残る可能性があります。暗号化は行いません。保存先を共有・同期する場合は利用者自身で保護してください。",
    "新しい保存先だけを作り、既存ファイルを上書きしません。元の会話・制約・利用量は変更しません。通信・推論・適用・自動再開は行いません。保存中は画面操作が一時停止します。ハッシュ検査は内容の正しさや署名を保証しません。",
  ].join("\n\n");
}
export class BackupBrowser {
  constructor(
    readonly app: Application,
    readonly dialogs: Dialogs,
  ) {}
  async save(argument?: string): Promise<void> {
    const sessionId = this.app.session.id;
    const current = () => {
      if (this.app.busy || this.app.session.id !== sessionId)
        throw new AgentError(
          "STALE_VIEW",
          "会話・作業状態が変わりました。/backup から選び直してください。",
        );
    };
    current();
    const input =
      argument ||
      (await this.dialogs.prompt(
        "履歴のバックアップ · 新しい保存先ディレクトリ（Agent領域・作業ディレクトリの外）",
      ));
    current();
    if (!input?.trim()) return;
    const preview = this.app.previewHistoryBackup(
      resolve(this.app.workspace, commandPath(input)),
    );
    if (
      !(await this.dialogs.show(
        backupPreviewText(preview),
        "履歴のバックアップ · 保存範囲",
        "確認へ進む",
      ))
    )
      return;
    current();
    if (
      !(await this.dialogs.confirm(
        "非公開の履歴アーカイブを作成しますか？ 稼働環境の復元・実行は行いません。",
      ))
    )
      return;
    current();
    const result = await this.app.confirmHistoryBackup(preview);
    this.dialogs.notice(
      `${result.files.length} ファイルと完了記録を保存しました。実行環境の復元・再開は行っていません。検査は agent backup-verify で行えます。`,
    );
  }
}
