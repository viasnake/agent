import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import { fixture, call, jobInput, untilJob } from "./support.js";

test("W05 W06: real browser sources, Markdown, Japanese PDF, Poppler inspection and all raster pages", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      request.url === "/a"
        ? "<title>資料 A</title><h1>資料 A</h1><p>処理は一つずつ実行し、途中結果を保存します。</p>"
        : "<title>資料 B</title><h1>資料 B</h1><p>再開には外部操作の結果確認が必要です。</p>",
    );
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`,
    date = new Date().toISOString().slice(0, 10);
  const markdown = `# 個人用 Agent の実行と復旧\n\n資料 A は逐次実行と保存、資料 B は外部操作の照合を説明しています。\n\n## 比較\n\n| 観点 | 資料 A | 資料 B |\n|---|---|---|\n| 目的 | 途中結果の保持 | 重複操作の防止 |\n\n## 根拠と出典\n\n- 資料 A: ${origin}/a — 確認日 ${date}\n  > 処理は一つずつ実行し、途中結果を保存します。\n- 資料 B: ${origin}/b — 確認日 ${date}\n  > 再開には外部操作の結果確認が必要です。\n\n## 推奨と制約\n\n保存と照合を組み合わせて運用します。これは固定した試験資料の比較です。実モデルの品質や実機の安全性は未確認です。\n\n<img src="https://attacker.invalid/pixel" onerror="alert(1)"><script>throw 1</script>\n`;
  const inspect: FauxResponseFactory = async (context) => {
    const result = context.messages.findLast(
      (message) =>
        message.role === "toolResult" && message.toolName === "render_document",
    );
    assert.ok(result && result.role === "toolResult");
    const output = JSON.parse(
      result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
    ) as { screenshots: string[] };
    return fauxAssistantMessage(
      output.screenshots.map((path) => fauxToolCall("inspect_image", { path })),
      { stopReason: "toolUse" },
    );
  };
  const { service } = await fixture(
    [
      call("fetch_source", { url: `${origin}/a` }),
      call("fetch_source", { url: `${origin}/b` }),
      call("write_file", { path: "report.md", text: markdown }),
      call("render_document", { source: "report.md", output: "report.pdf" }),
      inspect,
      call("publish_artifact", {
        path: "report.md",
        name: "report.md",
        mediaType: "text/markdown",
      }),
      call("self_review", {
        evidence:
          "PDF 全ページの画像、抽出された日本語、表の配置、出典と引用を確認しました。比較対象は固定 fixture に限定されます。",
      }),
      call("finish_job", {
        summary: "出典付き Markdown と日本語 PDF を納品しました",
        criteria: ["出典付き比較", "Markdown と PDF"],
        limitations: [],
      }),
    ],
    {
      workerOptions: {
        fixtureOrigin: origin,
        popplerBin: process.env.AGENT_TEST_POPPLER,
      },
    },
  );
  try {
    const { id } = await service.create(
      jobInput({
        kind: "research",
        title: "資料を比較する",
        objective:
          "指定した2つの資料を比較し、根拠と制約を日本語で報告してください",
        acceptance: ["出典付き比較", "Markdown と PDF"],
      }),
    );
    const job = await untilJob(
      service,
      id,
      (job) =>
        job.status === "succeeded" ||
        job.status === "failed" ||
        job.status === "waiting",
      45000,
    );
    assert.equal(job.status, "succeeded", job.detail);
    assert.equal(job.sources.length, 2);
    assert.ok(
      job.sources.every(
        (source) =>
          source.title && source.fetchedAt && source.quote && source.sha256,
      ),
    );
    assert.ok(
      job.renderPages.length > 0 &&
        job.renderPages.every((page) => page.inspected),
    );
    const pdf = job.artifacts.find(
      (artifact) => artifact.name === "report.pdf",
    )!;
    const bytes = await service.artifacts.read(pdf);
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    const inspection = job.artifacts.find((artifact) =>
      artifact.name.startsWith("pdf-inspection-"),
    )!;
    assert.match(
      (await service.artifacts.read(inspection)).toString(),
      /個人用|再開|実行/,
    );
    await mkdir("test-results", { recursive: true });
    await writeFile(resolve("test-results/report.pdf"), bytes);
    await writeFile(
      resolve("test-results/report.md"),
      await service.artifacts.read(
        job.artifacts.find((item) => item.name === "report.md")!,
      ),
    );
    await writeFile(
      resolve("test-results/report-page.png"),
      await service.artifacts.read(
        job.artifacts.find(
          (item) => item.id === job.renderPages[0]!.artifactId,
        )!,
      ),
    );
  } finally {
    await service.close();
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
  }
});

test("W09: worker starts a preview server and the real browser checks its rendered page", async () => {
  const { service } = await fixture([
    call("write_file", {
      path: "project/index.html",
      text: "<!doctype html><html lang=ja><meta charset=utf-8><title>試験アプリ</title><button onclick=\"this.textContent='確認済み'\">確認</button></html>",
    }),
    call("browser", {
      url: "http://127.0.0.1:3099/",
      previewCommand:
        "cd project && python3 -m http.server 3099 --bind 127.0.0.1",
      actionsJson: JSON.stringify([{ type: "click", selector: "button" }]),
    }),
    call("ask_user", {
      reason: "実ブラウザーで確認済みです。次の指示を待ちます。",
    }),
  ]);
  try {
    const { id } = await service.create(jobInput());
    const job = await untilJob(
      service,
      id,
      (job) => job.status === "waiting",
      30000,
    );
    assert.equal(job.waitReason, "user", job.detail);
    assert.ok(
      job.artifacts.some(
        (artifact) =>
          artifact.name.startsWith("browser-") &&
          artifact.mediaType === "image/png",
      ),
    );
    const view = JSON.stringify(await service.view(id));
    assert.match(view, /確認済み/);
  } finally {
    await service.close();
  }
});
