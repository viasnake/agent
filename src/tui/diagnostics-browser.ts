import { resolve } from "node:path";
import type { Application } from "../application.js";
import { diagnosticWarning } from "../diagnostics.js";
import { commandPath } from "./actions.js";
import { safeText } from "./components.js";

interface Dialogs {
  prompt(title: string): Promise<string | undefined>;
  show(text: string, title: string, accept: string): Promise<boolean>;
  confirm(text: string): Promise<boolean>;
  notice(text: string): void;
}
export class DiagnosticsBrowser {
  constructor(
    readonly app: Application,
    readonly dialogs: Dialogs,
  ) {}
  async save(argument?: string): Promise<void> {
    const input =
      argument ||
      (await this.dialogs.prompt(
        "共有用の限定診断 · 新しい保存先ファイル（Agent領域外）",
      ));
    if (!input?.trim()) return;
    const destination = resolve(this.app.workspace, commandPath(input));
    const target = safeText(destination);
    const fence = "`".repeat(
      Math.max(
        3,
        ...[...target.matchAll(/`+/g)].map((match) => match[0].length + 1),
      ),
    );
    const preview = await this.app.previewDiagnostics();
    if (
      !(await this.dialogs.show(
        `${diagnosticWarning}\n\n保存先:\n${fence}\n${target}\n${fence}\n\n\`\`\`json\n${preview.text}\`\`\``,
        "診断 · 保存内容の全体",
        "保存の確認へ",
      ))
    )
      return;
    if (
      !(await this.dialogs.confirm(
        "表示した診断を新しい非公開ファイルへ保存しますか？ 自動送信はしません。",
      ))
    )
      return;
    this.app.saveDiagnostics(preview, destination);
    this.dialogs.notice(
      "表示した診断を保存しました。共有前に内容を確認してください。通信・推論は行っていません。",
    );
  }
}
