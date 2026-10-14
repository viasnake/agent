import {
  Container,
  Editor,
  Input,
  Markdown,
  ScrollView,
  SelectList,
  Text,
  stripTerminalSequences,
  indexedColor,
  styleText,
  mixColors,
  rgbColor,
  truncateToWidth,
  visibleWidth,
  matchesKey,
  type Component,
  type Focusable,
  type TUI,
  type MarkdownTheme,
  type SelectListTheme,
  type TextStyle,
  type Color,
  type TerminalColors,
  type SelectItem,
} from "@earendil-works/pi-tui";

const plain = (text: string) => text;
let panelColor: Color | undefined;
export function terminalTheme(colors: TerminalColors): void {
  if (!colors.background || !colors.foreground) return;
  const { background: bg, foreground: fg } = colors;
  panelColor = mixColors(
    rgbColor(bg.r, bg.g, bg.b),
    rgbColor(fg.r, fg.g, fg.b),
    0.08,
  );
}
function styled(options: TextStyle): (text: string) => string {
  return (text) =>
    process.env.NO_COLOR || process.env.TERM === "dumb"
      ? text
      : styleText(text, options, "256color");
}
// Use the terminal's palette and background, including in light themes. Pi owns
// escape generation; untrusted text is sanitized before any styling is applied.
export const theme = {
  accent: styled({ fg: indexedColor(6) }),
  success: styled({ fg: indexedColor(2) }),
  error: styled({ fg: indexedColor(1), bold: true }),
  muted: styled({ dim: true }),
  strong: styled({ bold: true }),
  selected: styled({ inverse: true }),
  panel: (text: string) => styled({ bg: panelColor })(text),
};
export const selectTheme: SelectListTheme = {
  selectedPrefix: theme.accent,
  selectedText: theme.selected,
  description: theme.muted,
  scrollInfo: theme.muted,
  noMatch: theme.muted,
};
export const markdownTheme: MarkdownTheme = {
  heading: theme.strong,
  link: theme.accent,
  linkUrl: theme.muted,
  code: theme.accent,
  codeBlock: plain,
  codeBlockBorder: theme.muted,
  quote: theme.muted,
  quoteBorder: theme.muted,
  hr: theme.muted,
  listBullet: theme.muted,
  bold: theme.strong,
  italic: styled({ italic: true }),
  strikethrough: styled({ strikethrough: true }),
  underline: styled({ underline: true }),
  highlightCode: (code, language) =>
    code.split("\n").map((line) => {
      if (language !== "diff") return line;
      if (line.startsWith("+")) return theme.success(line);
      if (line.startsWith("-")) return theme.error(line);
      if (line.startsWith("@@")) return theme.accent(line);
      return line;
    }),
};
// Only pi-tui emits terminal controls. Remove C1 and bidi controls as well as
// escaped sequences before passing external data to Markdown or editor controls.
export function safeText(text: string): string {
  return stripTerminalSequences(text).replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
}
export function markdown(text: string): Markdown {
  return new Markdown(safeText(text), 0, 0, markdownTheme);
}
export class Composer extends Editor {
  heading = "依頼を書く";
  caption = "";
  placeholder = "依頼を入力…  @ ファイル  / コマンド";
  override renderTopBorder(width: number, hidden: number): string {
    return hidden
      ? super.renderTopBorder(width, hidden)
      : truncateToWidth(`  ${theme.strong(this.heading)}`, width, "", true);
  }
  override renderBottomBorder(width: number, hidden: number): string {
    return hidden
      ? super.renderBottomBorder(width, hidden)
      : truncateToWidth(`  ${this.caption}`, width, "…", true);
  }
  override render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    // Keep Pi's editor, wrapping, cursor markers, paste and completion behavior.
    // Only its public border hooks and rendered rows receive presentation styles.
    const lines = super.render(inner);
    if (!this.getText() && lines[1]) {
      lines[1] =
        lines[1]!.replace(/ +$/, "") +
        theme.muted(truncateToWidth(this.placeholder, Math.max(0, inner - 4)));
    }
    return lines.map(
      (line) =>
        theme.accent("▎ ") +
        theme.panel(truncateToWidth(line, inner, "", true)),
    );
  }
  override handleInput(data: string): void {
    super.handleInput(data);
    const text = this.getExpandedText(),
      safe = safeText(text);
    if (safe !== text) this.setText(safe);
  }
}
export function editor(tui: TUI): Composer {
  return new Composer(
    tui,
    { borderColor: theme.accent, selectList: selectTheme },
    { paddingX: 1, autocompleteMaxVisible: 5 },
  );
}

export function frame(
  title: string,
  body: string[],
  footer: string,
  width: number,
): string[] {
  const inner = Math.max(1, width - 4);
  const border = (text: string) => theme.muted(text);
  const cleanTitle = safeText(title);
  const extended =
    cleanTitle.includes("\n") || visibleWidth(cleanTitle) + 2 > inner;
  const heading = truncateToWidth(` ${extended ? "確認" : cleanTitle} `, inner);
  if (extended)
    body = [...new Text(cleanTitle, 0, 0).render(inner), "", ...body];
  return [
    border("╭─") +
      theme.strong(heading) +
      border("─".repeat(Math.max(0, inner - visibleWidth(heading))) + "─╮"),
    ...body.map(
      (line) =>
        border("│ ") + truncateToWidth(line, inner, "…", true) + border(" │"),
    ),
    border("│ ") +
      theme.muted(truncateToWidth(footer, inner, "…", true)) +
      border(" │"),
    border("╰" + "─".repeat(Math.max(0, width - 2)) + "╯"),
  ];
}

// A searchable picker keeps draft text and focus in the composer intact.
export class Picker implements Component, Focusable {
  readonly input = new Input({
    prompt: "/ ",
    placeholder: "検索…",
    placeholderStyle: theme.muted,
  });
  list: SelectList;
  private filteredChoices: SelectItem[];
  private maxVisible = 8;
  onSelect?: (value: string) => void;
  constructor(
    readonly title: string,
    private choices: SelectItem[],
    readonly searchable: boolean,
    private rows: number | (() => number),
  ) {
    this.filteredChoices = choices;
    this.list = this.createList(choices);
    this.input.onSubmit = () => {
      const item = this.list.getSelectedItem();
      if (item) this.onSelect?.(item.value);
    };
  }
  private createList(choices: SelectItem[]): SelectList {
    const list = new SelectList(choices, this.maxVisible, {
      ...selectTheme,
      noMatch: () => theme.muted("  一致する項目がありません"),
    });
    list.onSelect = (item) => this.onSelect?.(item.value);
    return list;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }
  get focused(): boolean {
    return this.input.focused;
  }
  invalidate(): void {
    this.list.invalidate();
    this.input.invalidate();
  }
  handleInput(data: string): void {
    if (
      !this.searchable ||
      (["up", "down", "pageUp", "pageDown"] as const).some((key) =>
        matchesKey(data, key),
      )
    )
      this.list.handleInput(data);
    else {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      const value = safeText(this.input.getValue());
      if (value !== this.input.getValue()) this.input.setValue(value);
      if (value !== previous) {
        // Pi's built-in filter only matches value prefixes. Match visible labels
        // and descriptions too, so Japanese labels and partial model IDs work.
        const words = value.toLocaleLowerCase().trim().split(/\s+/);
        this.filteredChoices = this.choices.filter((item) => {
          const text =
            `${item.value} ${item.label} ${item.description ?? ""}`.toLocaleLowerCase();
          return words.every((word) => text.includes(word));
        });
        this.list = this.createList(this.filteredChoices);
      }
    }
  }
  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const rows = typeof this.rows === "function" ? this.rows() : this.rows;
    const titleRows =
      this.title.includes("\n") || visibleWidth(this.title) + 2 > inner
        ? new Text(this.title, 0, 0).render(inner).length + 1
        : 0;
    const maxVisible = Math.max(
      1,
      Math.min(6, Math.floor((rows - 9 - titleRows) / 2)),
    );
    if (maxVisible !== this.maxVisible) {
      const selected = this.list.getSelectedItem();
      this.maxVisible = maxVisible;
      this.list = this.createList(this.filteredChoices);
      this.list.setSelectedIndex(
        selected ? this.filteredChoices.indexOf(selected) : 0,
      );
    }
    const selected = this.list.getSelectedItem();
    const index = selected ? this.filteredChoices.indexOf(selected) : 0;
    const start = Math.max(
      0,
      Math.min(
        index - Math.floor(maxVisible / 2),
        this.filteredChoices.length - maxVisible,
      ),
    );
    const items = this.filteredChoices.slice(start, start + maxVisible);
    return frame(
      this.title,
      [
        ...(this.searchable ? [...this.input.render(inner), ""] : []),
        ...(items.length
          ? items.flatMap((item) => {
              const active = item === selected;
              const label = truncateToWidth(
                `${active ? "›" : " "} ${item.label}`,
                inner,
                "…",
                true,
              );
              return [
                active ? theme.selected(label) : label,
                theme.muted(
                  truncateToWidth(`  ${item.description ?? ""}`, inner),
                ),
              ];
            })
          : [
              theme.muted("一致する項目がありません"),
              "検索語を短くするか、Esc で戻れます。",
            ].map((line) => truncateToWidth(line, inner))),
        ...(this.filteredChoices.length > maxVisible
          ? [theme.muted(`${index + 1} / ${this.filteredChoices.length} 件`)]
          : []),
        "",
      ],
      inner < 44 ? "Esc 戻る · ↑↓ · Enter" : "Esc 戻る   ↑↓ 選択   Enter 決定",
      width,
    );
  }
}

// Percentage sizing is resolved by Pi on every render, including terminal resize.
export class ResponsiveOverlay implements Component, Focusable {
  constructor(
    readonly content: Component & Partial<Focusable>,
    readonly maxWidth = 88,
  ) {}
  get focused(): boolean {
    return this.content.focused ?? false;
  }
  set focused(value: boolean) {
    this.content.focused = value;
  }
  handleInput(data: string): void {
    this.content.handleInput?.(data);
  }
  invalidate(): void {
    this.content.invalidate();
  }
  render(width: number): string[] {
    const inner = Math.min(width, this.maxWidth);
    const padding = " ".repeat(Math.max(0, Math.floor((width - inner) / 2)));
    return this.content.render(inner).map((line) => padding + line);
  }
}

export class ContentColumn extends Container {
  render(width: number): string[] {
    const inner = Math.max(1, Math.min(100, width - 4));
    const padding = " ".repeat(Math.max(0, Math.floor((width - inner) / 2)));
    return super.render(inner).map((line) => padding + line);
  }
}

// ScrollView owns follow/scroll state and Pi owns all wrapping/width calculations.
// Main-screen dialogs clip rendered rows, preserving native terminal scrollback.
export class Reader implements Component {
  readonly scroll: ScrollView;
  readonly content = markdown("");
  private readonly bytes: Buffer;
  private page = 0;
  private readonly pageBytes = 24000;
  constructor(
    readonly tui: TUI,
    text: string,
    readonly heading = "詳細",
    readonly acceptLabel = "",
  ) {
    this.bytes = Buffer.from(safeText(text));
    this.scroll = new ScrollView(this.content, {
      follow: "none",
      scrollbar: "hidden",
    });
    this.turnPage(0);
  }
  turnPage(direction: number): void {
    this.page = Math.max(
      0,
      Math.min(
        Math.ceil(this.bytes.length / this.pageBytes) - 1,
        this.page + direction,
      ),
    );
    const boundary = (offset: number): number => {
      while (
        offset < this.bytes.length &&
        (this.bytes[offset]! & 0xc0) === 0x80
      )
        offset++;
      return offset;
    };
    this.content.setText(
      this.bytes
        .subarray(
          boundary(this.page * this.pageBytes),
          boundary((this.page + 1) * this.pageBytes),
        )
        .toString("utf8"),
    );
    this.scroll.scrollToStart();
    this.tui.requestRender();
  }
  invalidate(): void {
    this.content.invalidate();
  }
  render(width: number): string[] {
    const lines = this.scroll.render(Math.max(1, width - 4));
    const height = Math.max(1, this.tui.terminal.rows - 9);
    this.scroll.updateLayout(lines.length, height, () =>
      this.tui.requestRender(),
    );
    const pageCount = Math.ceil(this.bytes.length / this.pageBytes);
    return frame(
      this.heading +
        (pageCount > 1 ? ` · ${this.page + 1}/${pageCount} ページ（←/→）` : ""),
      lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + height),
      `${this.acceptLabel ? `Enter ${this.acceptLabel}   ` : ""}Esc 閉じる   PgUp/PgDn ${Math.min(lines.length, this.scroll.scrollTop + 1)}–${Math.min(lines.length, this.scroll.scrollTop + height)}/${lines.length}`,
      width,
    );
  }
}
export class Dialog extends Container implements Focusable {
  constructor(readonly title = "入力") {
    super();
  }
  override render(width: number): string[] {
    return frame(
      this.title,
      super.render(Math.max(1, width - 4)),
      width < 48
        ? "Esc 戻る · Enter 決定"
        : "Esc 戻る   Enter 決定   Ctrl+J 改行",
      width,
    );
  }
  private control?: Component & Partial<Focusable>;
  private isFocused = false;
  set focused(value: boolean) {
    this.isFocused = value;
    if (this.control) this.control.focused = value;
  }
  get focused(): boolean {
    return this.isFocused;
  }
  setControl(component: Component & Partial<Focusable>): void {
    this.control = component;
    this.addChild(component);
    component.focused = this.focused;
  }
  handleInput(data: string): void {
    this.control?.handleInput?.(data);
  }
}
