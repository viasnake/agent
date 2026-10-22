import {
  BoxRenderable,
  InputRenderable,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { keyIdFromEvent } from "./keys.js";
import { Picker, safeText } from "./components.js";
import { TextRenderable, StyledText } from "@opentui/core";
import { theme } from "./theme.js";

export interface SettingsField {
  value: string;
  label: string;
  description?: string;
  current?: string | boolean;
}
export interface SettingsPosition {
  query: string;
  selected?: string;
  notice?: string;
}
export interface SettingsEdit {
  value: string;
  text?: string;
}

/**
 * 設定エディタ。Picker の下にインライン入力欄を出して値を編集する。
 * Esc は編集中なら編集だけを取り消し、そうでなければ閉じる。
 */
export class SettingsEditor extends BoxRenderable {
  readonly picker: Picker;
  editing?: SettingsField;
  readonly input: InputRenderable;
  private readonly inputBox: BoxRenderable;
  onSubmit?: (edit: SettingsEdit) => void;

  constructor(
    ctx: CliRenderer,
    title: string,
    readonly fields: SettingsField[],
    readonly settingsPosition: SettingsPosition,
  ) {
    super(ctx, { flexDirection: "column", width: "100%", focusable: true });
    this.picker = new Picker(
      ctx,
      title,
      fields.map((field) => ({
        ...field,
        label: safeText(
          `${field.label}${field.current === undefined ? "" : ` = ${field.current}`}`,
        ),
        description: field.description && safeText(field.description),
      })),
      true,
    );
    this.picker.restore(settingsPosition.query, settingsPosition.selected);
    this.picker.footerOverride = "↑↓ 選択  Enter 編集  Esc 閉じる";
    if (settingsPosition.notice) {
      const noticeBox = new BoxRenderable(ctx, { flexDirection: "column" });
      noticeBox.add(
        new TextRenderable(ctx, {
          content: new StyledText([
            theme.muted(safeText(settingsPosition.notice)),
          ]),
        }),
      );
      this.picker.setExtra(noticeBox);
    }
    this.inputBox = new BoxRenderable(ctx, {
      flexDirection: "row",
      visible: false,
      gap: 1,
    });
    this.inputBox.add(
      new TextRenderable(ctx, { content: "値:", flexShrink: 0 }),
    );
    this.input = new InputRenderable(ctx, {
      flexGrow: 1,
    } as ConstructorParameters<typeof InputRenderable>[1]);
    this.inputBox.add(this.input);
    this.add(this.picker);
    this.add(this.inputBox);
    this.picker.onSelect = (item) => {
      if (!item) return;
      const field = fields.find((entry) => entry.value === item.value);
      if (!field) return;
      this.settingsPosition.query = this.picker.input.value;
      this.settingsPosition.selected = item.value;
      if (typeof field.current === "boolean") {
        this.onSubmit?.({ value: item.value, text: String(!field.current) });
      } else if (field.current === undefined) {
        this.onSubmit?.({ value: item.value });
      } else {
        this.editing = field;
        this.input.value = safeText(field.current);
        // カーソルは行末へ（位置0だと先頭への追記になる）
        this.input.gotoLineEnd();
        this.inputBox.visible = true;
        this.picker.footerOverride = "Enter 保存  Esc 編集を取消";
      }
    };
  }

  /** 編集を一段階取り消す。戻り値は「取消した」かどうか。 */
  cancel(): boolean {
    if (!this.editing) return false;
    this.editing = undefined;
    this.inputBox.visible = false;
    this.picker.footerOverride = "↑↓ 選択  Enter 編集  Esc 閉じる";
    return true;
  }

  /** Esc 相当のキーなら true を返して上層に閉じる動作を任せる。 */
  private commitInput(): void {
    if (this.editing)
      this.onSubmit?.({
        value: this.editing.value,
        text: safeText(this.input.value),
      });
  }

  override handleKeyPress(key: KeyEvent): boolean {
    const id = keyIdFromEvent(key);
    if (id === "escape") {
      return this.cancel();
    }
    if (this.editing) {
      if (id === "enter") {
        this.commitInput();
        return true;
      }
      const handled = this.input.handleKeyPress(key);
      const clean = safeText(this.input.value);
      if (clean !== this.input.value) this.input.value = clean;
      return handled;
    }
    return this.picker.handleKeyPress(key);
  }
}
