/**
 * オートコンプリート。pi-tui の AutocompleteProvider 互換インターフェースと、
 * スラッシュコマンドの補完プロバイダ。
 */

export interface AutocompleteItem {
  /** 表示名（"/help" など）。 */
  value: string;
  /** 説明文。 */
  label?: string;
  /** 補足説明。 */
  description?: string;
}

export interface AutocompleteSuggestions {
  items: AutocompleteItem[];
  /** 補完対象のプレフィックス（行頭からの起点計算に使う）。 */
  prefix: string;
}

export interface AutocompleteContext {
  signal?: AbortSignal;
  force?: boolean;
}

export interface AutocompleteProvider {
  /** この文字が入力されると自動で補完候補を出す。 */
  triggerCharacters?: string[];
  /** 候補取得。lines=入力全文の行, cursorLine/cursorCol=カーソル位置。 */
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    context: AutocompleteContext,
  ): Promise<AutocompleteSuggestions | null> | AutocompleteSuggestions | null;
  /** 候補適用後の行とカーソル位置を返す。 */
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number };
  /** Tab 等で強制的にファイル補完を発火させてよいか。 */
  shouldTriggerFileCompletion?(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean;
}

/**
 * 現在のトークン（カーソル直前の空白区切り単語）を取得する。
 * 行頭または空白の直後にあるトークンのみ補完対象。
 */
export function tokenPrefix(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): { prefix: string; start: number } {
  const line = lines[cursorLine] ?? "";
  let start = cursorCol;
  while (start > 0 && !/\s/.test(line[start - 1]!)) start -= 1;
  return { prefix: line.slice(start, cursorCol), start };
}

/** スラッシュコマンド補完。行頭が "/" で始まる場合のみ発火する。 */
export class SlashCommandProvider implements AutocompleteProvider {
  readonly triggerCharacters = ["/"];

  constructor(
    private readonly commands: readonly {
      name: string;
      description?: string;
    }[],
  ) {}

  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): AutocompleteSuggestions | null {
    const line = lines[cursorLine] ?? "";
    if (!line.startsWith("/")) return null;
    const { prefix } = tokenPrefix(lines, cursorLine, cursorCol);
    if (!prefix.startsWith("/")) return null;
    const items = this.commands
      .filter(
        (command) =>
          `/${command.name}`.startsWith(prefix) &&
          `/${command.name}` !== prefix,
      )
      .map((command): AutocompleteItem => ({
        value: command.name,
        label: `/${command.name}`,
        description: command.description,
      }));
    if (items.length === 0) return null;
    return { items, prefix };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const line = lines[cursorLine] ?? "";
    const start = cursorCol - prefix.length;
    const inserted =
      prefix.startsWith("/") && !item.value.startsWith("/")
        ? `/${item.value}`
        : item.value;
    const nextLine = `${line.slice(0, start)}${inserted} ${line.slice(cursorCol)}`;
    const next = [...lines];
    next[cursorLine] = nextLine;
    return {
      lines: next,
      cursorLine,
      cursorCol: start + inserted.length + 1,
    };
  }

  shouldTriggerFileCompletion(): boolean {
    return false;
  }
}

/**
 * pi-tui CombinedAutocompleteProvider 相当。
 * basePath/fdPath は互換のため残す（fd 由来のファイル補完は
 * AttachmentAutocompleteProvider が担うためここでは使わない）。
 */
export class CombinedAutocompleteProvider extends SlashCommandProvider {
  constructor(
    commands: readonly { name: string; description?: string }[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _basePath?: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _fdPath?: string | null,
  ) {
    super(commands);
  }
}
