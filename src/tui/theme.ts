/**
 * TUI テーマ。StyledText のチャンクを返すスタイル関数の集合。
 * pi-tui 版では ANSI スタイル付き文字列を返していたが、OpenTUI では
 * TextChunk (fg/bg/attributes) を返す。
 */
import { RGBA, type TextChunk } from "@opentui/core";
import { TextAttributes } from "@opentui/core";

export interface TerminalThemeColors {
  defaultForeground: string | null;
  defaultBackground: string | null;
}

const chunk = (text: string, opts: Partial<TextChunk> = {}): TextChunk => ({
  __isChunk: true,
  text,
  ...opts,
});

let panelColor: RGBA | undefined;

function mix(base: RGBA, overlay: RGBA, ratio: number): RGBA {
  const blend = (a: number, b: number) => a + (b - a) * ratio;
  return RGBA.fromValues(
    blend(base.r, overlay.r),
    blend(base.g, overlay.g),
    blend(base.b, overlay.b),
    1,
  );
}

/** 端末パレット検出結果を反映する。呼ばれない場合はパネル背景なし。 */
export function terminalTheme(
  colors: TerminalThemeColors | null | undefined,
): void {
  if (!colors?.defaultForeground || !colors?.defaultBackground) {
    panelColor = undefined;
    return;
  }
  try {
    const fg = RGBA.fromHex(colors.defaultForeground);
    const bg = RGBA.fromHex(colors.defaultBackground);
    panelColor = mix(bg, fg, 0.08);
  } catch {
    panelColor = undefined;
  }
}

export const theme = {
  /** アクセント（ユーザ識別・選択・リンクなど）: 端末の cyan。 */
  accent: (text: string): TextChunk =>
    chunk(text, { fg: RGBA.fromHex("#56b6c2") }),
  /** 成功（緑）。 */
  success: (text: string): TextChunk =>
    chunk(text, { fg: RGBA.fromHex("#98c379") }),
  /** エラー（赤 + 太字）。 */
  error: (text: string): TextChunk =>
    chunk(text, {
      fg: RGBA.fromHex("#e06c75"),
      attributes: TextAttributes.BOLD,
    }),
  /** 弱調（dim）。 */
  muted: (text: string): TextChunk =>
    chunk(text, { attributes: TextAttributes.DIM }),
  /** 強調（太字）。 */
  strong: (text: string): TextChunk =>
    chunk(text, { attributes: TextAttributes.BOLD }),
  /** 選択行（アクセント背景 + 濃字）。INVERSE は端末依存で文字が潰れるため使わない。 */
  selected: (text: string): TextChunk =>
    chunk(text, { fg: RGBA.fromHex("#0b0f14"), bg: RGBA.fromHex("#56b6c2") }),
  /** パネル背景（端末配色からの混合色）。検出できない場合は背景なし。 */
  panel: (text: string): TextChunk =>
    panelColor ? chunk(text, { bg: panelColor }) : chunk(text),
};

export function panelBackground(): RGBA | undefined {
  return panelColor;
}
