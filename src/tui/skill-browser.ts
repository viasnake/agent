import type { Application } from "../application.js";
import { AgentError } from "../types.js";
import {
  listSkills,
  listSkillReferences,
  readSkill,
  skillAttachments,
} from "../skills.js";

interface Dialogs {
  choose(
    title: string,
    choices: { value: string; label: string; description?: string }[],
  ): Promise<string | undefined>;
  show(text: string, title: string, accept: string): Promise<boolean>;
  confirm(text: string): Promise<boolean>;
  notice(text: string): void;
  active(): boolean;
}

export class SkillBrowser {
  constructor(
    readonly app: Application,
    readonly dialogs: Dialogs,
  ) {}

  async select(path?: string): Promise<void> {
    const { id, workspace, draft } = this.app.session;
    const current = () => {
      if (
        !this.dialogs.active() ||
        this.app.busy ||
        this.app.session.id !== id ||
        this.app.session.workspace !== workspace ||
        this.app.session.draft !== draft
      )
        throw new AgentError(
          "STALE_VIEW",
          "会話・下書き・実行状態が変わりました。Skillsを選び直してください。",
        );
    };
    current();
    if (!path) {
      const catalog = await listSkills(workspace);
      current();
      if (!catalog.files.length) {
        this.dialogs.notice(
          `skills/<名前>/SKILL.md がありません。/skills 相対パス/SKILL.md でも指定できます。省略: ${catalog.skipped}${catalog.limited ? " · 列挙上限あり" : ""}`,
        );
        return;
      }
      path = await this.dialogs.choose(
        `Skills · 読取のみ · 省略 ${catalog.skipped}${catalog.limited ? " · 列挙上限あり" : ""}`,
        catalog.files.map((file) => ({
          value: file.path,
          label: file.path,
          description: `${file.bytes} bytes`,
        })),
      );
      current();
      if (!path) return;
    }
    const skill = await readSkill(workspace, path);
    current();
    const fence = "`".repeat(
      Math.max(
        3,
        ...[...skill.text.matchAll(/`+/g)].map((match) => match[0].length + 1),
      ),
    );
    if (
      !(await this.dialogs.show(
        `${skill.path}\nSHA-256: ${skill.sha256}\n${skill.bytes} bytes\n\n下書きへの選択だけです。送信・script実行・権限変更は行いません。送信時に原本を読み直して内容と送信先を確認します。\n\n${fence}\n${skill.text}\n${fence}`,
        "Skillの手順を確認",
        "参照資料の選択へ進む",
      ))
    )
      return;
    current();
    const references = await listSkillReferences(workspace, path);
    current();
    const selected = new Set<string>();
    while (references.files.length) {
      const choice = await this.dialogs.choose(
        `参照資料を明示選択 · ${selected.size}/7 · 省略 ${references.skipped}${references.limited ? " · 列挙上限あり" : ""}`,
        [
          { value: "done", label: "この選択で下書きへ進む" },
          ...references.files.map((file) => ({
            value: file.path,
            label: `${selected.has(file.path) ? "[選択] " : ""}${file.path}`,
            description: `${file.bytes} bytes`,
          })),
        ],
      );
      current();
      if (!choice) return;
      if (choice === "done") break;
      if (!references.files.some((file) => file.path === choice))
        throw new AgentError("STALE_VIEW", "参照資料の選択が無効です。");
      if (selected.has(choice)) selected.delete(choice);
      else if (selected.size < 7) selected.add(choice);
      else this.dialogs.notice("参照資料は7件までです。");
    }
    const addition = skillAttachments(path, [...selected]);
    const next = `${draft}${draft ? "\n" : ""}${addition}`;
    if (Buffer.byteLength(next) > this.app.config.limits.maxInputBytes)
      throw new AgentError("INPUT_SIZE", "下書きの入力上限を超えています。");
    if (
      !(await this.dialogs.confirm(
        `${addition}\n\nこの依頼のSkillとして下書きに追加します。取消は下書きの該当参照を削除してください。送信後の資料除外は /sources で行います。過去の発言の消去は保証しません。`,
      ))
    )
      return;
    current();
    this.app.setDraft(next);
    this.dialogs.notice(
      "Skillを下書きに選択しました。送信前に内容・機密区分・送信先を確認してください。",
    );
  }
}
