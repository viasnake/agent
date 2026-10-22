/**
 * テキストユーティリティ。
 *
 * pi-tui が提供していた端末幅計測・切り詰め・エスケープ除去のうち、
 * TUI 内部で必要なものを自前実装したもの。
 */

// ANSI/OSC などの端末制御シーケンスを除去する。
const ANSI_SEQUENCE_PATTERN =
  // CSI sequences (with optional intermediates), OSC sequences up to BEL/ST,
  // DCS/APC/PM/SOS up to ST, and remaining ESC-initiated sequences.
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-_]/g;

export function stripTerminalSequences(text: string): string {
  return text.replace(ANSI_SEQUENCE_PATTERN, "");
}

/**
 * 制御文字・BIDI 制御を取り除き、TUI 表示に安全な文字列を返す。
 * 改行 (\n) とタブ (\t) は維持する。
 */
export function safeText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return stripTerminalSequences(text).replace(
    // eslint-disable-next-line no-control-regex
    /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F‮‭‫‬‪-‮]/g,
    "",
  );
}

/** 表示幅（East Asian Width ベース、0/1/2 のいずれか）を返す。 */
export function charWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  // Combining marks, variation selectors, ZWJ/ZWNJ, control chars
  if (
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint < 0xa0) ||
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    codePoint === 0x200b ||
    codePoint === 0x200c ||
    codePoint === 0x200d ||
    codePoint === 0x2060 ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return 0;
  }
  // Fullwidth / Wide ranges
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x231a && codePoint <= 0x231b) || // Hourglass etc.
    (codePoint >= 0x2329 && codePoint <= 0x232a) || // Angle brackets
    (codePoint >= 0x23e9 && codePoint <= 0x23ec) ||
    codePoint === 0x23f0 ||
    codePoint === 0x23f3 ||
    (codePoint >= 0x25fd && codePoint <= 0x25fe) ||
    (codePoint >= 0x2614 && codePoint <= 0x2615) ||
    (codePoint >= 0x2630 && codePoint <= 0x2647) || // Trigrams
    (codePoint >= 0x2648 && codePoint <= 0x2653) ||
    (codePoint >= 0x267f && codePoint <= 0x267f) ||
    (codePoint >= 0x268a && codePoint <= 0x2693) ||
    (codePoint >= 0x26a1 && codePoint <= 0x26a1) ||
    (codePoint >= 0x26aa && codePoint <= 0x26ab) ||
    (codePoint >= 0x26bd && codePoint <= 0x26be) ||
    (codePoint >= 0x26c4 && codePoint <= 0x26c5) ||
    (codePoint >= 0x26ce && codePoint <= 0x26d4) ||
    (codePoint >= 0x26ea && codePoint <= 0x26ea) ||
    (codePoint >= 0x26f2 && codePoint <= 0x26f3) ||
    (codePoint >= 0x26f5 && codePoint <= 0x26f5) ||
    (codePoint >= 0x26fa && codePoint <= 0x26fa) ||
    (codePoint >= 0x26fd && codePoint <= 0x26fd) ||
    (codePoint >= 0x2705 && codePoint <= 0x2705) ||
    (codePoint >= 0x270a && codePoint <= 0x270b) ||
    codePoint === 0x2728 ||
    codePoint === 0x274c ||
    codePoint === 0x274e ||
    (codePoint >= 0x2753 && codePoint <= 0x2755) ||
    codePoint === 0x2757 ||
    (codePoint >= 0x2795 && codePoint <= 0x2797) ||
    codePoint === 0x27b0 ||
    codePoint === 0x27bf ||
    (codePoint >= 0x2b1b && codePoint <= 0x2b1c) ||
    codePoint === 0x2b50 ||
    codePoint === 0x2b55 ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK Radicals etc
    (codePoint >= 0x3041 && codePoint <= 0x33ff) || // Hiragana..CJK symbols
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Ext A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) || // Yi
    (codePoint >= 0xa960 && codePoint <= 0xa97c) || // Hangul Jamo Ext-B
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul Syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK Compat Ideographs
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) || // CJK Compat Forms
    (codePoint >= 0xfe70 && codePoint <= 0xfefc) || // Arabic Presentation
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // Fullwidth Forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) || // Fullwidth signs
    (codePoint >= 0x16fe0 && codePoint <= 0x16fe4) ||
    (codePoint >= 0x17000 && codePoint <= 0x18cd5) || // Tangut
    (codePoint >= 0x18d00 && codePoint <= 0x18d08) ||
    (codePoint >= 0x1aff0 && codePoint <= 0x1afff) ||
    (codePoint >= 0x1b000 && codePoint <= 0x1b2ff) || // Kana
    (codePoint >= 0x1cf00 && codePoint <= 0x1cfaf) ||
    (codePoint >= 0x1f200 && codePoint <= 0x1f251) || // Enclosed Ideographic
    (codePoint >= 0x1f260 && codePoint <= 0x1f265) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) || // Emoji
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1fa70 && codePoint <= 0x1faff) ||
    (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) || // Regional indicators
    (codePoint >= 0x20000 && codePoint <= 0x2fffd) || // CJK Ext B+
    (codePoint >= 0x30000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function visibleWidth(text: string): number {
  let width = 0;
  for (const char of stripTerminalSequences(text)) {
    width += charWidth(char.codePointAt(0)!);
  }
  return width;
}

/**
 * 指定した表示幅に収まるよう切り詰める。
 * `ellipsis` を指定すると切り詰め時に末尾をその文字列で置き換える。
 * `pad` が true の場合、スペースで `width` まで埋める。
 */
export function truncateToWidth(
  text: string,
  width: number,
  ellipsis?: string,
  pad?: boolean,
): string {
  const clean = stripTerminalSequences(text);
  if (width <= 0) return pad ? " ".repeat(Math.max(0, width)) : "";
  const ellipsisWidth = ellipsis ? visibleWidth(ellipsis) : 0;
  const limit =
    ellipsis && visibleWidth(clean) > width ? width - ellipsisWidth : width;
  let result = "";
  let used = 0;
  for (const char of clean) {
    const w = charWidth(char.codePointAt(0)!);
    if (used + w > limit) break;
    result += char;
    used += w;
  }
  if (ellipsis && used < visibleWidth(clean)) result += ellipsis;
  if (pad && used < width) {
    const padding = width - (result === clean ? used : visibleWidth(result));
    if (padding > 0) result += " ".repeat(padding);
  }
  return result;
}

/**
 * 簡易なワードラップ。`width` 表示桁で折り返した行の配列を返す。
 * 既存の改行は維持し、CJK でも文字単位で折る（pi-tui の Markdown 折り返し相当）。
 */
export function wrapLines(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of stripTerminalSequences(text).split("\n")) {
    if (width <= 0 || rawLine === "") {
      lines.push(rawLine);
      continue;
    }
    let current = "";
    let used = 0;
    for (const char of rawLine) {
      const w = charWidth(char.codePointAt(0)!);
      if (used + w > width && current !== "") {
        lines.push(current);
        current = "";
        used = 0;
      }
      current += char;
      used += w;
    }
    lines.push(current);
  }
  return lines;
}
