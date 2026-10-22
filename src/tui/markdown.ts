/**
 * markdown → StyledText 変換。
 *
 * pi-tui の markdown() 相当を自前実装したもの。対応要素:
 * 見出し（#-## 太字+アクセント）、コードフェンス（枠線 + diff ハイライト）、
 * 箇条書き・番号リスト、引用（│ プレフィックス）、水平線、表の区切り行除去、
 * インラインの太字/イタリック/コード/取り消し線/リンク。
 */
import { RGBA, StyledText, type TextChunk } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import { theme } from "./theme.js";
import { safeText } from "./text.js";

const CODE_FG = RGBA.fromHex("#56b6c2");
const DIFF_ADD_FG = RGBA.fromHex("#98c379");
const DIFF_DEL_FG = RGBA.fromHex("#e06c75");
const DIFF_HUNK_FG = RGBA.fromHex("#56b6c2");

const chunk = (text: string, opts: Partial<TextChunk> = {}): TextChunk => ({
  __isChunk: true,
  text,
  ...opts,
});

/**
 * インラインマークダウンをチャンク列に変換する。
 * ネストは扱わず、コードスパン最優先の単純スキャン。
 */
function inline(text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let rest = text;
  const flush = (raw: string) => {
    if (raw !== "") chunks.push(chunk(raw));
  };
  const pattern =
    /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\n]+\))/g;
  let last = 0;
  for (const m of rest.matchAll(pattern)) {
    const idx = m.index ?? 0;
    flush(rest.slice(last, idx));
    const token = m[0];
    if (m[1]) {
      chunks.push(chunk(token.slice(1, -1), { fg: CODE_FG }));
    } else if (m[2] || m[3]) {
      chunks.push(
        chunk(token.slice(2, -2), {
          attributes: m[2] ? TextAttributes.BOLD : TextAttributes.UNDERLINE,
        }),
      );
    } else if (m[4] || m[5]) {
      chunks.push(
        chunk(token.slice(1, -1), { attributes: TextAttributes.ITALIC }),
      );
    } else if (m[6]) {
      chunks.push(
        chunk(token.slice(2, -2), { attributes: TextAttributes.STRIKETHROUGH }),
      );
    } else if (m[7]) {
      const link = token.match(/\[([^\]]*)\]\(([^)]*)\)/);
      if (link) {
        chunks.push(chunk(link[1]!, { attributes: TextAttributes.BOLD }));
        chunks.push(
          chunk(` (${link[2]})`, {
            attributes: TextAttributes.DIM,
          }),
        );
      } else {
        flush(token);
      }
    }
    last = idx + token.length;
  }
  flush(rest.slice(last));
  return chunks;
}

/** markdown を行ごとのチャンク列（各行 = TextChunk[]）に変換する。 */
export function markdownLines(text: string): TextChunk[][] {
  const input = safeText(text);
  const rawLines = input.split("\n");
  const out: TextChunk[][] = [];
  let inFence = false;
  let fenceLang = "";

  for (const line of rawLines) {
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      inFence = !inFence;
      fenceLang = inFence ? (fence[1] ?? "") : "";
      out.push([chunk("│", { attributes: TextAttributes.DIM })]);
      continue;
    }
    if (inFence) {
      if (fenceLang === "diff") {
        if (line.startsWith("+")) {
          out.push([chunk(`  ${line}`, { fg: DIFF_ADD_FG })]);
          continue;
        }
        if (line.startsWith("-")) {
          out.push([chunk(`  ${line}`, { fg: DIFF_DEL_FG })]);
          continue;
        }
        if (line.startsWith("@@")) {
          out.push([chunk(`  ${line}`, { fg: DIFF_HUNK_FG })]);
          continue;
        }
      }
      out.push([chunk(`  ${line}`, { fg: CODE_FG })]);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      out.push([
        chunk(heading[2]!, {
          attributes: TextAttributes.BOLD,
          fg: CODE_FG,
        }),
      ]);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push([chunk("─".repeat(20), { attributes: TextAttributes.DIM })]);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      out.push([
        chunk("│ ", { attributes: TextAttributes.DIM }),
        ...inline(quote[1]!).map((c) => ({
          ...c,
          attributes: (c.attributes ?? 0) | TextAttributes.DIM,
        })),
      ]);
      continue;
    }
    // 表の区切り行は見た目のノイズなので除去
    if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("-")) {
      continue;
    }
    // 箇条書き・番号リストはそのまま行テキストとして保持
    out.push(inline(line));
  }
  // フェンスが閉じられていない場合も終端枠線は出さない（そのまま）
  return out;
}

/** markdown を StyledText に変換する。 */
export function markdownToStyled(text: string): StyledText {
  const lines = markdownLines(text);
  const chunks: TextChunk[] = [];
  lines.forEach((lineChunks, i) => {
    if (i > 0) chunks.push(chunk("\n"));
    chunks.push(...lineChunks);
  });
  return new StyledText(chunks);
}

/** 装装飾を除いたプレーンテキストを返す（テスト用）。 */
export function styledToPlain(styled: StyledText): string {
  return styled.chunks.map((c) => c.text).join("");
}

export { theme };
