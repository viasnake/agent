/**
 * TUI 共通コンポーネント（OpenTUI 実装）。
 *
 * pi-tui 版の Component.render(width): string[] モデルから、
 * OpenTUI の Renderable ツリーへ移植したもの。公開 API（Picker, Reader,
 * WorkbenchLayout, Composer, theme, markdown, safeText など）は
 * 可能な限り同名を維持する。
 */
import {
  BoxRenderable,
  InputRenderable,
  RGBA,
  ScrollBoxRenderable,
  TextareaRenderable,
  TextRenderable,
  defaultTextareaKeyBindings,
  type CliRenderer,
  type KeyBinding,
  StyledText,
  type KeyEvent,
  type PasteEvent,
  type Renderable,
  type TextChunk,
} from "@opentui/core";
import { markdownLines, markdownToStyled, styledToPlain } from "./markdown.js";
import { theme, terminalTheme, panelBackground } from "./theme.js";
import {
  safeText,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapLines,
} from "./text.js";
import { keyIdFromEvent, type KeyId } from "./keys.js";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "./autocomplete.js";
import { tokenPrefix } from "./autocomplete.js";

export {
  theme,
  terminalTheme,
  panelBackground,
  safeText,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapLines,
  markdownToStyled,
  markdownLines,
  styledToPlain,
};
export type { StyledText, TextChunk, KeyEvent, PasteEvent };
export type { KeyId };

/** markdown 表示用 TextRenderable。`setText` で中身を差し替える。 */
export class MarkdownText extends TextRenderable {
  constructor(ctx: CliRenderer, text = "") {
    super(ctx, {
      content: markdownToStyled(text),
      wrapMode: "word",
      flexShrink: 1,
    });
  }
  setText(text: string): void {
    this.content = markdownToStyled(text);
  }
}

/** pi-tui の markdown() 相当のファクトリ。 */
export function markdown(ctx: CliRenderer, text = ""): MarkdownText {
  return new MarkdownText(ctx, text);
}

/** 1 行のステータス表示用 TextRenderable（StyledText 対応）。 */
export class StatusLine extends TextRenderable {
  constructor(ctx: CliRenderer, text: string | StyledText = "") {
    super(ctx, { content: text, flexShrink: 1 });
  }
  setText(text: string | StyledText): void {
    this.content = text;
  }
}

const COMPOSER_KEY_BINDINGS: KeyBinding[] = [
  ...defaultTextareaKeyBindings.filter(
    (binding) =>
      !(binding.name === "return" && !binding.meta && !binding.shift) &&
      !(binding.name === "return" && binding.shift) &&
      !(binding.name === "kpenter" && !binding.meta),
  ),
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "linefeed", action: "newline" },
] as KeyBinding[];

/**
 * 入力欄。pi-tui Editor の代替。TextareaRenderable を包み、
 * 履歴・オートコンプリート・改行ルール（Enter=送信、Shift+Enter/キーパッドEnter=改行）
 * を維持する。
 */
export class Composer extends BoxRenderable {
  readonly textarea: TextareaRenderable;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;

  private readonly autocompleteBox: BoxRenderable;
  private autocompleteItems: AutocompleteItem[] = [];
  private autocompletePrefix = "";
  private autocompleteIndex = 0;
  private autocompleteSeq = 0;
  private provider?: AutocompleteProvider;
  private readonly history: string[] = [];
  private historyIndex = -1;
  private historyDraft = "";
  private lastText = "";

  constructor(ctx: CliRenderer) {
    super(ctx, { flexDirection: "column", flexShrink: 0, focusable: true });
    this.autocompleteBox = new BoxRenderable(ctx, {
      flexDirection: "column",
      visible: false,
      maxHeight: 6,
      overflow: "hidden",
    });
    this.textarea = new TextareaRenderable(ctx, {
      keyBindings: COMPOSER_KEY_BINDINGS,
      minHeight: 1,
      maxHeight: 6,
      wrapMode: "word",
      onSubmit: () => this.submit(),
      onChange: () => this.changed(),
    } as ConstructorParameters<typeof TextareaRenderable>[1]);
    this.add(this.autocompleteBox);
    this.add(this.textarea);
  }

  /** 現在の入力（改行保持）。 */
  getExpandedText(): string {
    return this.textarea.plainText;
  }

  getText(): string {
    return this.getExpandedText();
  }

  setText(text: string): void {
    this.textarea.setText(safeText(text));
    this.textarea.gotoBufferEnd();
    this.hideAutocomplete();
    this.resetHistory();
    this.changed();
  }

  addToHistory(text: string): void {
    if (!text) return;
    this.history.push(text);
    if (this.history.length > 100) this.history.shift();
    this.resetHistory();
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.provider = provider;
  }

  isShowingAutocomplete(): boolean {
    return this.autocompleteBox.visible === true;
  }

  private resetHistory(): void {
    this.historyIndex = -1;
    this.historyDraft = "";
  }

  private submit(): void {
    const text = this.getExpandedText();
    this.hideAutocomplete();
    this.resetHistory();
    this.onSubmit?.(text);
  }

  private changed(): void {
    const text = this.getExpandedText();
    const grow = Math.max(1, Math.min(6, this.textarea.lineCount));
    if (this.textarea.height !== grow) this.textarea.height = grow;
    this.onChange?.(text);
    if (text !== this.lastText) {
      this.lastText = text;
      void this.updateAutocomplete();
    }
  }

  override handlePaste(event: PasteEvent): void {
    // 貼り付けは改行・タブを残して制御シーケンスのみ除去する
    const clean = safeText(new TextDecoder().decode(event.bytes));
    if (clean) this.textarea.insertText(clean);
    event.preventDefault();
  }

  override handleKeyPress(key: KeyEvent): boolean {
    // SS3 のキーパッド Enter（\x1bOM）は従来どおり改行として扱う。
    if (key.sequence === "\x1bOM" || key.raw === "\x1bOM") {
      this.textarea.newLine();
      this.changed();
      return true;
    }
    if (this.isShowingAutocomplete()) {
      const id = keyIdFromEvent(key);
      if (id === "up") {
        this.moveAutocomplete(-1);
        return true;
      }
      if (id === "down") {
        this.moveAutocomplete(1);
        return true;
      }
      if (id === "enter" || id === "tab") {
        this.acceptAutocomplete();
        return true;
      }
      if (id === "escape") {
        this.hideAutocomplete();
        return true;
      }
    } else {
      const id = keyIdFromEvent(key);
      if (id === "up" && this.textarea.logicalCursor.row === 0) {
        if (this.recallHistory(1)) return true;
      }
      if (
        id === "down" &&
        this.textarea.logicalCursor.row === this.textarea.lineCount - 1
      ) {
        if (this.recallHistory(-1)) return true;
      }
      if (id === "tab") {
        void this.updateAutocomplete(true);
        return true;
      }
    }
    const handled = this.textarea.handleKeyPress(key);
    this.changed();
    return handled;
  }

  private recallHistory(direction: 1 | -1): boolean {
    if (!this.history.length) return false;
    const text = this.getExpandedText();
    if (this.historyIndex < 0) {
      if (direction < 0) return false;
      this.historyDraft = text;
      this.historyIndex = this.history.length;
    }
    const next = this.historyIndex - direction;
    if (next < 0 || next > this.history.length) return false;
    this.historyIndex = next;
    const value =
      this.historyIndex === this.history.length
        ? this.historyDraft
        : this.history[this.historyIndex]!;
    this.textarea.setText(value);
    this.textarea.gotoBufferEnd();
    this.changed();
    return true;
  }

  private cursorLines(): { lines: string[]; row: number; col: number } {
    const text = this.getExpandedText();
    const lines = text.split("\n");
    const cursor = this.textarea.logicalCursor;
    return { lines, row: cursor.row, col: cursor.col };
  }

  private async updateAutocomplete(force = false): Promise<void> {
    const provider = this.provider;
    if (!provider) return;
    const { lines, row, col } = this.cursorLines();
    const seq = ++this.autocompleteSeq;
    const suggestions = await Promise.resolve(
      provider.getSuggestions(lines, row, col, { force }),
    );
    if (seq !== this.autocompleteSeq) return;
    if (!suggestions || suggestions.items.length === 0) {
      this.hideAutocomplete();
      return;
    }
    this.autocompleteItems = suggestions.items;
    this.autocompletePrefix = suggestions.prefix;
    this.autocompleteIndex = 0;
    this.renderAutocomplete();
  }

  private moveAutocomplete(delta: number): void {
    if (!this.autocompleteItems.length) return;
    this.autocompleteIndex =
      (this.autocompleteIndex + delta + this.autocompleteItems.length) %
      this.autocompleteItems.length;
    this.renderAutocomplete();
  }

  private acceptAutocomplete(): void {
    const provider = this.provider;
    const item = this.autocompleteItems[this.autocompleteIndex];
    if (!provider || !item) {
      this.hideAutocomplete();
      return;
    }
    const { lines, row, col } = this.cursorLines();
    const result = provider.applyCompletion(
      lines,
      row,
      col,
      item,
      this.autocompletePrefix,
    );
    this.textarea.setText(result.lines.join("\n"));
    this.textarea.setCursor(result.cursorLine, result.cursorCol);
    this.hideAutocomplete();
    this.changed();
  }

  private hideAutocomplete(): void {
    this.autocompleteSeq += 1;
    this.autocompleteItems = [];
    this.autocompleteBox.visible = false;
    for (const child of [...this.autocompleteBox.getChildren()])
      this.autocompleteBox.remove(child);
  }

  private renderAutocomplete(): void {
    for (const child of [...this.autocompleteBox.getChildren()])
      this.autocompleteBox.remove(child);
    this.autocompleteItems.slice(0, 6).forEach((item, index) => {
      const selected = index === this.autocompleteIndex;
      const primary = item.label ?? item.value;
      const line = new TextRenderable(this.ctx as CliRenderer, {
        content: new StyledText([
          {
            __isChunk: true,
            text: ` ${primary}`,
            ...(selected ? theme.selected(primary) : {}),
          },
          theme.muted(` ${item.description ?? ""}`.trimEnd()),
        ]),
      });
      this.autocompleteBox.add(line);
    });
    this.autocompleteBox.visible = true;
  }
}

function composerEditor(ctx: CliRenderer): Composer {
  return new Composer(ctx);
}

/** pi-tui の editor(tui) 相当のファクトリ。 */
export function editor(ctx: CliRenderer): Composer {
  return composerEditor(ctx);
}

/**
 * 枠線つきブロックをプレーン文字列で生成する（テスト・固定表示用）。
 * ボックス描画は ╭─│╰╮、フッターは枠の下に置く。
 */
export function frame(
  title: string,
  body: string[],
  footer: string[] | string | null,
  width: number,
): string[] {
  const inner = Math.max(1, width - 2);
  const titleText = title ? ` ${stripTerminalSequences(title)} ` : "";
  const fill = Math.max(0, inner - visibleWidth(titleText) - 1);
  const lines = [`╭─${titleText}${"─".repeat(fill)}╮`];
  for (const raw of body) {
    lines.push(
      `│${truncateToWidth(stripTerminalSequences(raw), inner, "…", true)}│`,
    );
  }
  lines.push(`╰${"─".repeat(inner)}╯`);
  if (footer) {
    for (const line of Array.isArray(footer) ? footer : [footer]) {
      lines.push(
        ` ${truncateToWidth(stripTerminalSequences(line), width - 1, "…")}`,
      );
    }
  }
  return lines;
}

export interface PickerItem {
  value: string;
  label: string;
  description?: string;
}

/**
 * 検索付き選択パネル。pi-tui Picker の代替。
 * 上から 検索入力・候補リスト・説明・フッターの構成。
 */
/** 枠線タイトルは内幅を超えると描画ごと落ちるため、先に収まる長さへ切り詰める。 */
function borderTitle(ctx: CliRenderer, title: string): string {
  return truncateToWidth(safeText(title), Math.max(8, ctx.width - 16), "…");
}

export class Picker extends BoxRenderable {
  readonly input: InputRenderable;
  onSelect?: (item: PickerItem | null) => void;

  private readonly listBox: BoxRenderable;
  private readonly description: StatusLine;
  private readonly footer: StatusLine;
  /** フッター文言の上書き（設定エディタが使う）。 */
  footerOverride?: string;
  private extra: BoxRenderable | null = null;
  private all: PickerItem[] = [];
  private filtered: PickerItem[] = [];
  private index = 0;

  constructor(
    ctx: CliRenderer,
    title: string,
    items: PickerItem[],
    searchable: boolean,
    private readonly rows: () => number = () => ctx.height,
  ) {
    super(ctx, {
      border: true,
      title: borderTitle(ctx, title),
      flexDirection: "column",
      width: "100%",
      maxHeight: Math.max(8, rows() - 4),
      backgroundColor: panelBackground() ?? RGBA.fromHex("#10131a"),
      paddingX: 1,
      gap: 0,
      focusable: true,
    });
    this.all = items;
    this.filtered = items;
    this.input = new InputRenderable(ctx, {
      placeholder: "検索…",
      width: "100%",
      visible: searchable,
    } as ConstructorParameters<typeof InputRenderable>[1]);
    this.listBox = new BoxRenderable(ctx, {
      flexDirection: "column",
      overflow: "hidden",
      flexShrink: 1,
    });
    this.description = new StatusLine(ctx, "");
    this.footer = new StatusLine(ctx, "");
    this.add(this.input);
    this.add(this.listBox);
    this.add(this.description);
    this.add(this.footer);
    this.rebuild();
  }

  /** 下部の補助領域（設定エディタの入力欄など）。 */
  setExtra(content: BoxRenderable | null): void {
    if (this.extra) this.remove(this.extra);
    this.extra = content;
    if (content) this.add(content);
  }

  get maxVisible(): number {
    // 自身の描画高ではなく端末高から出す（内容高に自己制限されて常時3件になるのを防ぐ）
    return Math.max(3, Math.min(10, this.rows() - 8));
  }

  private query(): string {
    return this.input.value;
  }

  /** クエリ・選択・一覧・フッターの表示を最新状態へ反映する。 */
  rebuild(): void {
    const q = this.query().toLowerCase();
    this.filtered = this.all.filter(
      (item) =>
        !q ||
        item.value.toLowerCase().includes(q) ||
        item.label.toLowerCase().includes(q) ||
        (item.description ?? "").toLowerCase().includes(q),
    );
    if (this.index >= this.filtered.length)
      this.index = Math.max(0, this.filtered.length - 1);
    for (const child of [...this.listBox.getChildren()])
      this.listBox.remove(child);
    const visible = this.filtered.slice(0, this.maxVisible);
    const start =
      this.index >= this.maxVisible ? this.index - this.maxVisible + 1 : 0;
    const ctx = this.ctx as CliRenderer;
    this.filtered.slice(start, start + this.maxVisible).forEach((item, i) => {
      const selected = start + i === this.index;
      const label = `${selected ? "▸" : " "} ${item.label}`;
      const line = new TextRenderable(ctx, {
        content: new StyledText([
          selected ? theme.selected(label) : { __isChunk: true, text: label },
        ]),
      });
      this.listBox.add(line);
      void visible;
    });
    const current = this.filtered[this.index];
    this.description.setText(
      current?.description
        ? new StyledText([theme.muted(safeText(current.description))])
        : "",
    );
    this.footer.setText(
      new StyledText([
        theme.muted(
          this.footerOverride ??
            (this.filtered.length
              ? "↑↓ 選択  Enter 決定  Esc 戻る"
              : "一致する項目がありません"),
        ),
      ]),
    );
  }

  /** Enter で確定。選択項目がなければ何もしない。 */
  private selectCurrent(): void {
    const item = this.filtered[this.index] ?? null;
    this.onSelect?.(item);
  }

  override handleKeyPress(key: KeyEvent): boolean {
    const id = keyIdFromEvent(key);
    if (id === "up" || (id as KeyId) === ("ctrl+p" as KeyId)) {
      this.index = Math.max(0, this.index - 1);
      this.rebuild();
      return true;
    }
    if (id === "down" || (id as KeyId) === ("ctrl+n" as KeyId)) {
      this.index = Math.min(this.filtered.length - 1, this.index + 1);
      this.rebuild();
      return true;
    }
    if (id === "pageUp") {
      this.index = Math.max(0, this.index - this.maxVisible);
      this.rebuild();
      return true;
    }
    if (id === "pageDown") {
      this.index = Math.min(
        this.filtered.length - 1,
        this.index + this.maxVisible,
      );
      this.rebuild();
      return true;
    }
    if (id === "enter") {
      this.selectCurrent();
      return true;
    }
    if (id === "escape") return false; // オーバーレイ側で閉じる
    const handled = this.input.handleKeyPress(key);
    this.rebuild();
    return handled;
  }

  /** クエリと選択を復元する（ページングで同じ項目を再選択する際に使用）。 */
  restore(query: string, value?: string): void {
    this.input.value = query;
    this.rebuild();
    if (value !== undefined) {
      const idx = this.filtered.findIndex((item) => item.value === value);
      if (idx >= 0) {
        this.index = idx;
        this.rebuild();
      }
    }
  }

  /** 現在選択中の項目（絞り込み後）。 */
  get selected(): PickerItem | null {
    return this.filtered[this.index] ?? null;
  }

  /** 絞り込み済みの項目一覧。 */
  get items(): readonly PickerItem[] {
    return this.filtered;
  }
}

/** ダイアログ（枠 + タイトル + 任意のコントロール）。 */
export class Dialog extends BoxRenderable {
  private control: BoxRenderable | null = null;
  constructor(ctx: CliRenderer, title: string, footer = "Esc 閉じる") {
    super(ctx, {
      border: true,
      title: borderTitle(ctx, title),
      bottomTitle: safeText(footer),
      flexDirection: "column",
      width: "100%",
      backgroundColor: panelBackground() ?? RGBA.fromHex("#10131a"),
      paddingX: 1,
      focusable: true,
    });
  }
  setControl(control: BoxRenderable): void {
    if (this.control) this.remove(this.control);
    this.control = control;
    this.add(control);
  }
  override handleKeyPress(key: KeyEvent): boolean {
    return this.control?.handleKeyPress?.(key) ?? false;
  }
}

const READER_PAGE_BYTES = 24000;

/** 長文リーダー（ページ分割 + スクロール）。 */
export class Reader extends BoxRenderable {
  readonly scroll: ScrollBoxRenderable;
  private readonly body: MarkdownText;
  private readonly footer: StatusLine;
  private pages: string[] = [];
  private page = 0;

  constructor(
    ctx: CliRenderer,
    text: string,
    title = "詳細",
    accept = "",
    private readonly pageBytes = READER_PAGE_BYTES,
  ) {
    super(ctx, {
      border: true,
      title: borderTitle(ctx, title),
      flexDirection: "column",
      width: "100%",
      backgroundColor: panelBackground() ?? RGBA.fromHex("#10131a"),
      paddingX: 1,
      focusable: true,
    });
    // maxHeight は整数行で固定する。パーセント指定だと Yoga が小数高を割り当て、
    // OpenTUI にクリップがないため描画高の切り上げ分がフッター行へ滲む。
    // オーバーレイ解除後もリスナーが残らないよう、ツリーから外れた時点で解除する。
    const fitMaxHeight = () => {
      let node: Renderable | null = this;
      while (node.parent) node = node.parent;
      if (node !== ctx.root) {
        ctx.off("resize", fitMaxHeight);
        return;
      }
      this.maxHeight = Math.max(8, ctx.height - 4);
    };
    fitMaxHeight();
    ctx.on("resize", fitMaxHeight);
    this.scroll = new ScrollBoxRenderable(ctx, {
      flexGrow: 1,
      flexShrink: 1,
      minHeight: 0, // 内容高をそのまま取ってフッターへ滲まないよう縮小を許す
      scrollY: true,
      stickyScroll: false,
      viewportCulling: true,
    });
    // クリックでスクロールがフォーカスを奪い、本文のキー入力が吞まれるのを防ぐ
    this.scroll.focusable = false;
    this.scroll.verticalScrollBar.focusable = false;
    this.body = markdown(ctx, "");
    this.footer = new StatusLine(ctx, "");
    this.footer.flexShrink = 0;
    this.scroll.add(this.body);
    this.add(this.scroll);
    this.add(this.footer);
    this.pages = this.splitPages(text);
    this.accept = accept;
    this.renderPage();
  }

  private accept: string;

  private splitPages(text: string): string[] {
    const clean = safeText(text);
    const pages: string[] = [];
    let rest = clean;
    while (Buffer.byteLength(rest) > this.pageBytes) {
      let cut = Math.min(rest.length, this.pageBytes);
      while (
        cut < rest.length &&
        Buffer.byteLength(rest.slice(0, cut)) < this.pageBytes
      )
        cut += 1;
      const slice = rest.slice(0, cut);
      const newline = slice.lastIndexOf("\n");
      const at = newline > this.pageBytes * 0.5 ? newline : slice.length;
      pages.push(rest.slice(0, at));
      rest = rest.slice(at).replace(/^\n+/, "");
    }
    pages.push(rest);
    return pages;
  }

  private renderPage(): void {
    this.body.setText(this.pages[this.page] ?? "");
    const chunks: TextChunk[] = [
      theme.muted(
        `Esc 閉じる  PgUp/PgDn スクロール${this.pages.length > 1 ? `  ${this.page + 1}–${this.pages.length}/${this.pages.length}` : ""}`,
      ),
    ];
    if (this.accept) chunks.push(theme.accent(`  Enter ${this.accept}`));
    this.footer.setText(new StyledText(chunks));
  }

  turnPage(direction: number): void {
    const next = Math.min(
      this.pages.length - 1,
      Math.max(0, this.page + direction),
    );
    if (next === this.page) return;
    this.page = next;
    this.scroll.scrollTop = 0;
    this.renderPage();
  }

  get pageCount(): number {
    return this.pages.length;
  }
  get currentPage(): number {
    return this.page;
  }

  override handleKeyPress(key: KeyEvent): boolean {
    const id = keyIdFromEvent(key);
    if (id === "pageUp") {
      this.scroll.scrollBy(-1, "viewport");
      return true;
    }
    if (id === "pageDown") {
      this.scroll.scrollBy(1, "viewport");
      return true;
    }
    return false;
  }
}

/**
 * オーバーレイ。画面全体を覆う絶対配置のコンテナで、
 * コンテンツを中央（または指定アンカー）に幅制限つきで表示する。
 */
export class ResponsiveOverlay extends BoxRenderable {
  constructor(
    ctx: CliRenderer,
    content: BoxRenderable,
    maxWidth = 88,
    anchor: "center" | "bottom-center" = "center",
  ) {
    super(ctx, {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      justifyContent: anchor === "center" ? "center" : "flex-end",
      alignItems: "center",
      paddingX: 1,
      paddingY: 1,
    });
    content.width = "100%";
    content.maxWidth = maxWidth;
    this.add(content);
  }
}

/**
 * 会話スクロール領域。上端までのオーバースクロールで
 * `onOlder` を呼び出し、prepend 前後の表示位置を保持する。
 */
export class ConversationScroll extends ScrollBoxRenderable {
  onOlder?: (remaining: number) => void;

  private pendingTop: number | (() => number) | null = null;
  private prependMark: {
    top: number;
    height: number;
    remaining: number;
  } | null = null;
  private applyingPending = false;
  private followEnd = true;
  private lastScrollHeight = 0;

  constructor(ctx: CliRenderer) {
    super(ctx, {
      flexGrow: 1,
      flexShrink: 1,
      minHeight: 0,
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
      viewportCulling: true,
      paddingX: 1,
      live: true, // onUpdate でレイアウト確定後のスクロール補正を行う
    });
    // クリックでスクロールがフォーカスを奪い、入力欄のキー入力が吞まれるのを防ぐ。
    // defaultFocusable=true のクラスは options.focusable=false が効かないためセッターで落とす。
    this.focusable = false;
    this.verticalScrollBar.focusable = false;
    // onUpdate はレイアウト前に走るため、同フレーム内で scrollHeight が
    // 伸びたケース（prepend / 追従）は renderAfter でも適用する。
    this.renderAfter = () => this.applyPending();
  }

  /** レイアウト確定後に保留中のスクロール補正を適用する。 */
  protected override onUpdate(deltaTime: number): void {
    super.onUpdate(deltaTime);
    this.applyPending();
  }

  get viewportHeight(): number {
    return this.viewport.height;
  }

  /** 下端追従中かどうか。 */
  get isFollowingEnd(): boolean {
    return this.scrollTop + this.viewportHeight >= this.scrollHeight - 1;
  }

  scrollToEnd(): void {
    this.followEnd = true;
    this.scrollTo(this.scrollHeight);
  }

  scrollToStart(): void {
    this.followEnd = false;
    this.scrollTo(0);
  }

  /**
   * 上方向のスクロールが限界に達したとき `onOlder` を呼ぶ。
   * 呼び出し側は `preserveAfterPrepend` で位置を維持する。
   */
  override scrollBy(
    delta: number | { x: number; y: number },
    unit?: "absolute" | "viewport" | "content" | "step",
  ): void {
    const y = typeof delta === "number" ? delta : delta.y;
    const before = this.scrollTop;
    super.scrollBy(delta as number, unit ?? "absolute");
    if (y < 0) this.followEnd = false;
    else if (this.isFollowingEnd) this.followEnd = true;
    // 上端に達したら残りのスクロール量（正数）を onOlder に渡す。
    if (y < 0 && this.scrollTop === 0) {
      const remaining = -(y + before);
      if (remaining > 0) this.onOlder?.(remaining);
    }
  }

  /** 次のレイアウト確定後に scrollTop を設定する（関数可）。 */
  scrollAfterLayout(top: number | (() => number)): void {
    this.pendingTop = top;
    this.applyPending();
  }

  /** prepend 前に呼んで現在位置を記録する。 */
  markPrepend(): void {
    this.prependMark = {
      top: this.scrollTop,
      height: this.scrollHeight,
      remaining: 0,
    };
  }

  /**
   * prepend 後に呼ぶ。コンテンツ高が確定し次第、
   * 旧表示位置 + 追加行数 - remaining にスクロールする。
   */
  preserveAfterPrepend(remaining = 0): void {
    if (!this.prependMark) {
      this.prependMark = {
        top: this.scrollTop,
        height: this.scrollHeight,
        remaining,
      };
      return;
    }
    this.prependMark.remaining = remaining;
    this.applyPending();
  }

  private applyPending(): void {
    if (this.applyingPending) return;
    this.applyingPending = true;
    try {
      // 下端追従中にコンテンツが伸びたら追従を維持する
      // （スクロール位置は次フレームで適用される）。
      if (this.followEnd && this.scrollHeight > this.lastScrollHeight) {
        this.scrollTop = Math.max(0, this.scrollHeight - this.viewportHeight);
      }
      this.lastScrollHeight = this.scrollHeight;
      if (this.prependMark) {
        const added = this.scrollHeight - this.prependMark.height;
        if (added > 0) {
          this.scrollTop = Math.max(
            0,
            this.prependMark.top + added - this.prependMark.remaining,
          );
          this.prependMark = null;
        }
      }
      if (this.pendingTop !== null) {
        const target =
          typeof this.pendingTop === "function"
            ? this.pendingTop()
            : this.pendingTop;
        this.scrollTop = Math.max(0, target);
        this.pendingTop = null;
      }
    } finally {
      this.applyingPending = false;
    }
  }
}

/**
 * ワークベンチレイアウト。
 * 上から スクロールする会話領域（rows 相当）と、下部の固定行（refs・入力・ステータス）。
 */
export class WorkbenchLayout extends BoxRenderable {
  readonly scroll: ConversationScroll;
  readonly footer: BoxRenderable;

  constructor(ctx: CliRenderer, rows: Renderable[], footer: Renderable[]) {
    super(ctx, {
      flexDirection: "column",
      width: "100%",
      height: "100%",
    });
    this.scroll = new ConversationScroll(ctx);
    this.footer = new BoxRenderable(ctx, {
      flexDirection: "column",
      flexShrink: 0,
      paddingX: 1,
    });
    for (const row of rows) this.scroll.content.add(row);
    this.add(this.scroll);
    for (const row of footer) this.footer.add(row);
    this.add(this.footer);
  }
}

export type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions };
export { tokenPrefix };
