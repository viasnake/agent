import { z } from "zod";
import { AgentError } from "./types.js";
import { sha256 } from "./util.js";

export const writingOptionsSchema = z.strictObject({
  style: z.enum(["polite", "plain", "unspecified"]).default("unspecified"),
  mustKeep: z.array(z.string().min(1).max(1000)).max(100).default([]),
  terminology: z
    .array(
      z.strictObject({
        preferred: z.string().min(1).max(100),
        alternatives: z.array(z.string().min(1).max(100)).max(20),
      }),
    )
    .max(100)
    .default([]),
});
export type WritingOptions = z.infer<typeof writingOptionsSchema>;
export interface WritingFinding {
  code:
    | "required_literal"
    | "fact_literal"
    | "terminology"
    | "style"
    | "particle"
    | "long_sentence";
  severity: "error" | "review";
  location: {
    document: "source" | "candidate" | "requirement";
    line: number;
    sourceId?: string;
    selectedTextSha256?: string;
    candidatePath?: string;
    candidateSha256?: string;
    requirementIndex?: number;
  };
  evidence: string;
  message: string;
}
export interface WritingReview {
  version: 1;
  scope: "literal-and-style-heuristics";
  sourceSha256: string;
  candidateSha256: string;
  requiredLiteralsPassed: boolean;
  findings: WritingFinding[];
  truncated: boolean;
  limitations: string[];
}

const maxBytes = 1_000_000;
const maxFindings = 200;
const factPatterns = [
  /https?:\/\/[^\s<>「」『』（）()"']{1,2000}/gu,
  /[0-9０-９]{1,4}(?:[-/年][0-9０-９]{1,2})(?:[-/月][0-9０-９]{1,2}日?)?/gu,
  /[0-9０-９]{1,2}(?:[:：][0-9０-９]{2}|時(?:[0-9０-９]{1,2}分)?)/gu,
  /[+-]?[0-9０-９]{1,15}(?:[,，][0-9０-９]{3}){0,4}(?:[.．][0-9０-９]{1,10})?\s{0,2}(?:円|万円|億円|人|名|件|個|台|回|歳|日|時間|分|秒|%|％|kg|km|GB|MB|USD|JPY)(?![A-Za-z])/gu,
];

export function reviewWriting(
  source: string,
  candidate: string,
  input: unknown = {},
): WritingReview {
  const options = writingOptionsSchema.parse(input);
  if (
    Buffer.byteLength(source) > maxBytes ||
    Buffer.byteLength(candidate) > maxBytes
  )
    throw new AgentError(
      "WRITING_SIZE",
      "Select a source/candidate excerpt of at most 1 MB each",
    );
  const sourceLines = source.split("\n");
  const candidateLines = candidate.split("\n");
  if (sourceLines.length > 10000 || candidateLines.length > 10000)
    throw new AgentError(
      "WRITING_SIZE",
      "Select excerpts of at most 10000 lines each",
    );
  const findings: WritingFinding[] = [];
  let truncated = false;
  const add = (finding: WritingFinding) => {
    if (findings.length < maxFindings) findings.push(finding);
    else truncated = true;
  };
  const requiredLiteralsPassed = options.mustKeep.every((literal) =>
    candidate.includes(literal),
  );
  for (const [index, literal] of options.mustKeep.entries()) {
    if (!candidate.includes(literal))
      add({
        code: "required_literal",
        severity: "error",
        location: { document: "requirement", line: index + 1 },
        evidence: literal,
        message: "利用者が保持を指定した文字列が出力にありません。",
      });
  }
  const seen = new Set<string>(options.mustKeep);
  let factCount = 0;
  facts: for (const [index, line] of sourceLines.entries()) {
    for (const pattern of factPatterns) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const literal = match[0];
        if (seen.has(literal)) continue;
        if (factCount >= 1000) {
          truncated = true;
          break facts;
        }
        seen.add(literal);
        factCount++;
        if (!candidate.includes(literal))
          add({
            code: "fact_literal",
            severity: "review",
            location: { document: "source", line: index + 1 },
            evidence: literal,
            message:
              "元の数値・日時・URL表記が出力にありません。削除や誤変更か、同じ意味の書き換えかを確認してください。",
          });
      }
    }
  }
  for (const [index, line] of candidateLines.entries()) {
    if (!line.trim()) continue;
    if (findings.length >= maxFindings) {
      truncated = true;
      break;
    }
    const location = { document: "candidate" as const, line: index + 1 };
    for (const term of options.terminology) {
      for (const alternative of term.alternatives) {
        if (
          alternative !== term.preferred &&
          line.replaceAll(term.preferred, "").includes(alternative)
        )
          add({
            code: "terminology",
            severity: "review",
            location,
            evidence: alternative,
            message: `指定用語「${term.preferred}」との表記ゆれを確認してください。引用や固有名詞は自動置換しません。`,
          });
      }
    }
    for (const sentence of line.split(/[。！？!?]/u)) {
      const text = sentence.trim();
      if (!text) continue;
      const ending = text.replace(/[」』）)]+$/u, "");
      const mismatch =
        options.style === "polite"
          ? /(?:である|だった|なのだ)$/u.test(ending)
          : options.style === "plain" &&
            /(?:です|ます|でした|ました|ません)$/u.test(ending);
      if (mismatch)
        add({
          code: "style",
          severity: "review",
          location,
          evidence: text.slice(0, 200),
          message:
            "指定された敬体・常体と異なる文末の可能性があります。引用やコードは文脈で判断してください。",
        });
      if ([...text].length > 120)
        add({
          code: "long_sentence",
          severity: "review",
          location,
          evidence: text.slice(0, 200),
          message:
            "長い文です。条件や例外を削らずに分割できるか確認してください。",
        });
      const duplicate = /(?:をを|がが|にに|でで|はは)/u.exec(text);
      if (duplicate)
        add({
          code: "particle",
          severity: "review",
          location,
          evidence: text.slice(
            Math.max(0, duplicate.index - 20),
            duplicate.index + 40,
          ),
          message:
            "助詞が重複している可能性があります。語の一部の場合もあるため文脈を確認してください。",
        });
    }
  }
  return {
    version: 1,
    scope: "literal-and-style-heuristics",
    sourceSha256: sha256(source),
    candidateSha256: sha256(candidate),
    requiredLiteralsPassed,
    findings,
    truncated,
    limitations: [
      "これは文字列と表現のヒューリスティック検査です。誤字・曖昧さ・冗長さの網羅的検出や意味的一致を保証しません。",
      "固有名詞・指示・否定・条件・例外・新たな事実の追加は人または独立レビューで原文と照合してください。",
      "同じ数値が別の対象に付け替えられた場合は検出できません。文字列が残っていることは事実保持の証明ではありません。",
      "必須文字列以外の指摘は不合格判定ではありません。引用・コード・URL末尾の句読点や等価な表記変更は誤検出になり得ます。",
      ...(truncated
        ? [
            "検査量または指摘数の上限に達したため一部のみ表示しています。範囲を分けて再検査してください。",
          ]
        : []),
    ],
  };
}
