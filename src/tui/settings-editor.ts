import {
  Input,
  Text,
  matchesKey,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { Picker, safeText } from "./components.js";

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

export class SettingsEditor implements Component, Focusable {
  readonly picker: Picker;
  private editing?: SettingsField;
  private readonly input = new Input({ prompt: "値: " });
  onSubmit?: (edit: SettingsEdit) => void;
  constructor(
    title: string,
    readonly fields: SettingsField[],
    readonly position: SettingsPosition,
    rows: () => number,
  ) {
    this.picker = new Picker(
      title,
      fields.map((field) => ({
        ...field,
        label: safeText(
          `${field.label}${field.current === undefined ? "" : ` = ${field.current}`}`,
        ),
        description: field.description && safeText(field.description),
      })),
      true,
      rows,
    );
    this.picker.restore(position.query, position.selected);
    this.picker.extra = position.notice
      ? new Text(safeText(position.notice), 0, 0)
      : undefined;
    this.picker.footer = "↑↓ 選択  Enter 編集  Esc 閉じる";
    this.picker.onSelect = (value) => {
      const field = fields.find((item) => item.value === value)!;
      this.position.query = this.picker.input.getValue();
      this.position.selected = value;
      if (typeof field.current === "boolean")
        this.onSubmit?.({ value, text: String(!field.current) });
      else if (field.current === undefined) this.onSubmit?.({ value });
      else {
        this.editing = field;
        this.input.setValue(safeText(field.current));
        this.picker.focused = false;
        this.input.focused = true;
        this.picker.extra = this.input;
        this.picker.footer = "Enter 保存  Esc 編集を取消";
      }
    };
    this.input.onSubmit = (text) => {
      if (this.editing)
        this.onSubmit?.({ value: this.editing.value, text: safeText(text) });
    };
  }
  set focused(value: boolean) {
    this.picker.focused = value && !this.editing;
    this.input.focused = value && !!this.editing;
  }
  get focused(): boolean {
    return this.picker.focused || this.input.focused;
  }
  cancel(): boolean {
    if (!this.editing) return false;
    this.editing = undefined;
    this.picker.extra = undefined;
    this.picker.footer = "↑↓ 選択  Enter 編集  Esc 閉じる";
    this.focused = true;
    return true;
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape") && this.cancel()) return;
    if (this.editing) {
      this.input.handleInput(data);
      const clean = safeText(this.input.getValue());
      if (clean !== this.input.getValue()) this.input.setValue(clean);
    } else this.picker.handleInput(data);
  }
  invalidate(): void {
    this.picker.invalidate();
    this.input.invalidate();
  }
  render(width: number): string[] {
    return this.picker.render(width);
  }
}
