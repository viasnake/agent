import test from "node:test";
import assert from "node:assert/strict";
import { reviewWriting } from "../src/writing-quality.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess, cleanEnvironment } from "../src/process.js";

test("literal checks distinguish explicit requirements from suspected factual rewrites", () => {
  const source =
    "青葉会議\n2026年11月5日 14:30\n参加費0円\nhttps://example.org/info";
  const review = reviewWriting(source, "青葉会議は午後二時半からです。", {
    mustKeep: ["青葉会議", "参加費0円"],
    style: "polite",
  });
  assert.equal(review.requiredLiteralsPassed, false);
  assert.equal(
    review.findings.filter((finding) => finding.severity === "error").length,
    1,
  );
  assert.ok(
    review.findings.some(
      (finding) =>
        finding.code === "fact_literal" &&
        finding.evidence === "2026年11月5日" &&
        finding.location.line === 2,
    ),
  );
  assert.ok(
    review.findings.some(
      (finding) =>
        finding.code === "fact_literal" && finding.evidence === "14:30",
    ),
  );
  assert.ok(
    review.findings.some(
      (finding) => finding.evidence === "https://example.org/info",
    ),
  );
  assert.equal(review.scope, "literal-and-style-heuristics");
  assert.equal(
    reviewWriting(source, source, { mustKeep: ["青葉会議", "参加費0円"] })
      .findings.length,
    0,
  );
});

test("Japanese style, terminology, particles and long sentences only request review", () => {
  const review = reviewWriting(
    "",
    "ユーザがが参加するのである。\n" + "あ".repeat(121) + "。",
    {
      style: "polite",
      terminology: [{ preferred: "ユーザー", alternatives: ["ユーザ"] }],
    },
  );
  assert.deepEqual(
    new Set(review.findings.map((finding) => finding.code)),
    new Set(["style", "terminology", "particle", "long_sentence"]),
  );
  assert.ok(review.findings.every((finding) => finding.severity === "review"));
  assert.equal(review.requiredLiteralsPassed, true);
  assert.equal(review.truncated, false);
  assert.ok(
    reviewWriting("", "これは案内です。", { style: "plain" }).findings.some(
      (finding) => finding.code === "style",
    ),
  );
});

test("bounded reports disclose truncation and do not claim semantic fact validation", () => {
  const review = reviewWriting(
    Array.from({ length: 300 }, (_, i) => `${i}人`).join("\n"),
    "",
  );
  assert.equal(review.findings.length, 200);
  assert.equal(review.truncated, true);
  assert.ok(review.limitations.some((line) => line.includes("一部のみ表示")));
  const reassigned = reviewWriting("Aは10人。Bは20人。", "Aは20人。Bは10人。");
  assert.equal(reassigned.findings.length, 0);
  assert.ok(reassigned.limitations.some((line) => line.includes("別の対象")));
  assert.throws(() => reviewWriting("あ".repeat(400000), ""), {
    code: "WRITING_SIZE",
  });
});

test("local writing CLI checks exact requirements without initialization or model access", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-writing-check-"));
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const source = join(root, "original.md");
  const candidate = join(root, "candidate.md");
  try {
    await writeFile(source, "参加費0円。ユーザー向けです。");
    await writeFile(candidate, "参加費1円。ユーザー向けである。");
    const result = await runProcess(
      process.execPath,
      [
        cli,
        "--home",
        join(root, "unused"),
        "--json",
        "writing-check",
        "--source",
        source,
        "--candidate",
        candidate,
        "--must-keep",
        "参加費0円",
        "--style",
        "polite",
      ],
      { env: cleanEnvironment, timeoutMs: 30000, maxBytes: 100000 },
    );
    assert.equal(result.code, 1, result.stderr);
    const review = JSON.parse(result.stdout);
    assert.equal(review.requiredLiteralsPassed, false);
    assert.ok(
      review.findings.some(
        (finding: { code: string }) => finding.code === "style",
      ),
    );
    assert.equal(review.scope, "literal-and-style-heuristics");
    assert.equal(
      reviewWriting("", "ユーザー向けです。", {
        terminology: [{ preferred: "ユーザー", alternatives: ["ユーザ"] }],
      }).findings.length,
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
