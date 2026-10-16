import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateConfig } from "../src/config.js";
import { TaskTools } from "../src/tools.js";
import { fetchPublic, type PublicFetchResult } from "../src/network.js";
import { decodeResponse } from "../src/research.js";
import { Sandbox } from "../src/sandbox.js";
import { TaskExecutor } from "../src/task-executor.js";
import { McpTools } from "../src/mcp.js";
import {
  independentReviewGuidelines,
  japaneseWritingGuidelines,
  researchGuidelines,
} from "../src/guidelines.js";
import { AgentError, type Task } from "../src/types.js";
import { fixture, ScriptedRuntime, testConfig } from "./helpers.js";

function response(
  url: string,
  body: string,
  mediaType: string,
): PublicFetchResult {
  return {
    url,
    body: Buffer.from(body),
    contentType: `${mediaType}; charset=utf-8`,
    mediaType,
    charset: "utf-8",
    lastModified: "Tue, 01 Oct 2024 00:00:00 GMT",
    retrievedAt: "2024-10-02T00:00:00.000Z",
  };
}

function fixtureTask(role: Task["role"] = "worker", write = false): Task {
  return {
    id: "fixture-task",
    objective: "Research the evidence",
    role,
    dependsOn: [],
    model: role === "reviewer" ? "reviewer" : "worker",
    write,
    state: "running",
    attempts: 0,
  };
}

test("research fetch stores raw and deterministic extracted sources while search remains discovery-only", async () => {
  const config = testConfig();
  config.web.allowedHosts = ["example.com"];
  config.web.search = {
    endpoint: "https://example.com/search",
    queryParam: "q",
  };
  const f = await fixture(new ScriptedRuntime(async () => "unused"), config);
  let calls = 0;
  try {
    const run = await f.harness.create({
      kind: "research",
      access: "read-only",
      objective: "Research the supplied topic",
      dataClass: "public",
    });
    const owned = f.store.claim(run.id);
    const task = fixtureTask();
    const tools = new TaskTools(
      config,
      f.store,
      owned,
      task,
      f.store.runDir(owned.id),
      new Sandbox(config.execution),
      async (url) => {
        calls++;
        if (url.pathname === "/search")
          return response(
            url.href,
            JSON.stringify({
              results: [
                {
                  title: "Discovery title",
                  url: "https://example.com/facts",
                  snippet: "Discovery-only snippet",
                },
                {
                  title: "Rejected URL",
                  url: "javascript:alert(1)",
                  snippet: "must not survive",
                },
              ],
            }),
            "application/json",
          );
        return response(
          url.href,
          "<html><body><header>Header</header><script>RAW_ONLY_SECRET</script><h1>Facts</h1><table><tr><th>Key</th><td>Value</td></tr></table><img alt='untrusted label'><footer>Footer</footer></body></html>",
          "text/html",
        );
      },
    );
    const specs = tools.all();
    const fetchTool = specs.find((tool) => tool.name === "fetch_source")!;
    const fetched = await fetchTool.execute(
      { url: "https://example.com/facts" },
      new AbortController().signal,
    );
    const source = JSON.parse(fetched) as { sourceId: string; text: string };
    assert.match(source.text, /Header/);
    assert.match(source.text, /Facts/);
    assert.match(source.text, /3:  \| Key \| Value/);
    assert.match(source.text, /untrusted alt text/);
    assert.match(source.text, /Footer/);
    assert.doesNotMatch(fetched, /RAW_ONLY_SECRET/);

    const artifacts = f.store.artifacts(owned.id);
    const raw = artifacts.find((artifact) => artifact.kind === "source-raw")!;
    const extracted = artifacts.find(
      (artifact) =>
        artifact.kind === "source" && artifact.id === source.sourceId,
    )!;
    assert.equal(extracted.metadata.rawArtifactId, raw.id);
    assert.equal(extracted.metadata.rawSha256, raw.sha256);
    assert.match(
      (await f.store.content(raw)).toString("utf8"),
      /RAW_ONLY_SECRET/,
    );
    const read = await specs
      .find((tool) => tool.name === "read_source")!
      .execute({ id: source.sourceId }, new AbortController().signal);
    assert.doesNotMatch(read, /RAW_ONLY_SECRET/);

    const searched = await specs
      .find((tool) => tool.name === "search_web")!
      .execute(
        { query: "exact query", limit: 2 },
        new AbortController().signal,
      );
    const report = JSON.parse(searched);
    assert.equal(report.query, "exact query");
    assert.equal(report.searchUrl, "https://example.com/search?q=exact+query");
    assert.equal(report.retrievedAt, "2024-10-02T00:00:00.000Z");
    assert.match(report.responseSha256, /^[a-f0-9]{64}$/);
    assert.equal(report.discoveryOnly, true);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].snippet, "Discovery-only snippet");
    assert.equal(report.results[0].fetchAllowed, true);
    assert.equal(calls, 2);
    assert.equal(
      f.store
        .artifacts(owned.id)
        .filter((artifact) => artifact.kind === "source").length,
      1,
    );
    f.store.release(owned);
  } finally {
    await f.cleanup();
  }
});

test("research disclosure denial occurs before the injected fetcher", async () => {
  const config = testConfig();
  config.web.allowedHosts = ["example.com"];
  config.web.allowedData = ["public"];
  const f = await fixture(new ScriptedRuntime(async () => "unused"), config);
  let calls = 0;
  try {
    const run = await f.harness.create({
      kind: "research",
      access: "read-only",
      objective: "Research privately",
      dataClass: "private",
    });
    const owned = f.store.claim(run.id);
    const tools = new TaskTools(
      config,
      f.store,
      owned,
      fixtureTask(),
      f.store.runDir(owned.id),
      new Sandbox(config.execution),
      async () => {
        calls++;
        return response("https://example.com/", "unexpected", "text/plain");
      },
    );
    await assert.rejects(
      tools
        .all()
        .find((tool) => tool.name === "fetch_source")!
        .execute({ url: "https://example.com/" }, new AbortController().signal),
      { code: "DISCLOSURE_DENIED" },
    );
    assert.equal(calls, 0);
    f.store.release(owned);
  } finally {
    await f.cleanup();
  }
});

test("unconfigured search reports unavailable without falling back to fetch", async () => {
  const config = testConfig();
  const f = await fixture(new ScriptedRuntime(async () => "unused"), config);
  let calls = 0;
  try {
    const run = await f.harness.create({
      kind: "research",
      access: "read-only",
      objective: "Search for sources",
      dataClass: "public",
    });
    const owned = f.store.claim(run.id);
    const tools = new TaskTools(
      config,
      f.store,
      owned,
      fixtureTask(),
      f.store.runDir(owned.id),
      new Sandbox(config.execution),
      async () => {
        calls++;
        throw new Error("Unconfigured search must not call the transport");
      },
    );
    await assert.rejects(
      tools
        .all()
        .find((tool) => tool.name === "search_web")!
        .execute({ query: "no fallback" }, new AbortController().signal),
      { code: "SEARCH_UNAVAILABLE" },
    );
    assert.equal(calls, 0);
    f.store.release(owned);
  } finally {
    await f.cleanup();
  }
});

test("search endpoint configuration and extracted output enforce strict bounds", () => {
  const invalid = testConfig();
  invalid.web.allowedHosts = ["example.com"];
  invalid.web.search = {
    endpoint: "https://user:pass@example.com:444/search",
    queryParam: "q",
  };
  assert.throws(() => validateConfig(invalid), { code: "CONFIG" });

  const source = response(
    "https://example.com/text",
    "é".repeat(100),
    "text/plain",
  );
  const extracted = decodeResponse(source, 32);
  assert.equal(Buffer.byteLength(extracted.text), 32);
  assert.equal(extracted.metadata.truncated, true);
  assert.throws(
    () => decodeResponse({ ...source, charset: "unsupported-charset" }, 100),
    (error) => error instanceof AgentError && error.code === "SOURCE_ENCODING",
  );
  assert.throws(
    () =>
      decodeResponse(
        {
          ...source,
          body: Buffer.from([0x80]),
          charset: "us-ascii",
          contentType: "text/plain; charset=us-ascii",
        },
        100,
      ),
    { code: "SOURCE_ENCODING" },
  );
  assert.throws(
    () =>
      decodeResponse(
        {
          ...source,
          body: Buffer.from([0x82]),
          charset: "shift_jis",
          contentType: "text/plain; charset=shift_jis",
        },
        100,
      ),
    { code: "SOURCE_ENCODING" },
  );
});

test("public fetch captures bounded response bytes through an injected transport", async () => {
  let calls = 0;
  const result = await fetchPublic(
    new URL("https://example.com/source"),
    new AbortController().signal,
    ["example.com"],
    1000,
    {
      request: async (_url) => {
        calls++;
        return new Response("captured body", {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "last-modified": "Wed, 02 Oct 2024 00:00:00 GMT",
          },
        }) as never;
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.body.toString("utf8"), "captured body");
  assert.equal(result.lastModified, "Wed, 02 Oct 2024 00:00:00 GMT");
});

test("public fetch stops before requesting excluded redirect destinations", async () => {
  let calls = 0;
  await assert.rejects(
    fetchPublic(
      new URL("https://example.com/alias"),
      new AbortController().signal,
      ["example.com", "excluded.example"],
      1000,
      {
        excludedUrls: ["https://excluded.example/private"],
        request: async () => {
          calls++;
          return new Response(null, {
            status: 302,
            headers: { location: "https://excluded.example/private" },
          }) as never;
        },
      },
    ),
    { code: "SOURCE_EXCLUDED" },
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    fetchPublic(
      new URL("https://excluded.example/private"),
      new AbortController().signal,
      ["excluded.example"],
      1000,
      {
        excludedUrls: ["https://excluded.example/private"],
        request: async () => {
          calls++;
          throw new Error("Excluded URL must not be requested");
        },
      },
    ),
    { code: "SOURCE_EXCLUDED" },
  );
  assert.equal(calls, 0);
});

test("research checkpoints authorize source references and check_writing keeps host literals", async () => {
  const config = testConfig();
  const f = await fixture(new ScriptedRuntime(async () => "unused"), config);
  try {
    const run = await f.harness.create({
      kind: "research",
      access: "read-only",
      objective: "Research stored evidence",
      dataClass: "private",
    });
    const owned = f.store.claim(run.id);
    const source = await f.store.artifact(
      owned,
      "facts.txt",
      "source",
      "A source sentence.\nAnother sentence.",
    );
    owned.mustKeep = ["host-critical"];
    const work = join(f.store.runDir(run.id), "work");
    await mkdir(work, { recursive: true });
    await writeFile(join(work, "candidate.md"), "A source sentence.\n");
    const tools = new TaskTools(
      config,
      f.store,
      owned,
      fixtureTask(),
      work,
      new Sandbox(config.execution),
    );
    const specs = tools.all();
    const checkpoint = specs.find(
      (tool) => tool.name === "research_checkpoint",
    )!;
    await checkpoint.execute(
      {
        summary: "A retained summary",
        searchedScopes: ["configured web"],
        openQuestions: ["Which date is definitive?"],
        decisions: [{ text: "Retain one finding", sourceIds: [source.id] }],
      },
      new AbortController().signal,
    );
    const saved = JSON.parse(
      await specs
        .find((tool) => tool.name === "read_research_checkpoint")!
        .execute({}, new AbortController().signal),
    );
    assert.equal(saved.author, "model");
    assert.equal(saved.trusted, false);
    assert.equal(saved.summary, "A retained summary");
    await assert.rejects(
      checkpoint.execute(
        {
          summary: "Invalid source",
          searchedScopes: [],
          openQuestions: [],
          decisions: [
            { text: "No", sourceIds: ["00000000-0000-4000-8000-000000000000"] },
          ],
        },
        new AbortController().signal,
      ),
      { code: "SOURCE" },
    );

    const checked = await specs
      .find((tool) => tool.name === "check_writing")!
      .execute(
        {
          path: "candidate.md",
          sourceId: source.id,
          style: "plain",
          mustKeep: ["model-literal"],
          terminology: [],
        },
        new AbortController().signal,
      );
    const report = JSON.parse(checked);
    assert.equal(report.sourceId, source.id);
    assert.equal(report.heuristicOnly, true);
    assert.ok(
      report.review.findings.some(
        (finding: { code: string; evidence: string }) =>
          finding.code === "required_literal" &&
          finding.evidence.includes("host-critical"),
      ),
    );
    const reports = f.store
      .artifacts(owned.id)
      .filter((artifact) => artifact.kind === "report")
      .map((artifact) => artifact.name);
    assert.ok(reports.some((name) => name.startsWith("research/checkpoint-")));
    assert.ok(reports.some((name) => name.startsWith("writing/check-")));
    const followup = await f.harness.create({
      kind: "chat",
      access: "read-only",
      objective: "Read retained research context",
      dataClass: "private",
      contextState: owned.contextState,
    });
    const followupOwned = f.store.claim(followup.id);
    const followupTools = new TaskTools(
      config,
      f.store,
      followupOwned,
      fixtureTask(),
      f.store.runDir(followup.id),
      new Sandbox(config.execution),
    ).all();
    const carriedCheckpoint = JSON.parse(
      await followupTools
        .find((tool) => tool.name === "read_research_checkpoint")!
        .execute({}, new AbortController().signal),
    );
    assert.equal(carriedCheckpoint.summary, "A retained summary");
    assert.equal(carriedCheckpoint.author, "model");
    assert.equal(carriedCheckpoint.trusted, false);
    f.store.release(followupOwned);
    f.store.release(owned);
  } finally {
    await f.cleanup();
  }
});

test("task executor wires frozen research, writing, and independent reviewer guidelines", async () => {
  const runtime = new ScriptedRuntime(async () => "fixture response");
  const f = await fixture(runtime);
  try {
    const executor = new TaskExecutor(
      f.config,
      f.store,
      runtime,
      new Sandbox(f.config.execution),
      () => {},
    );
    for (const [kind, role, expected] of [
      ["research", "worker", researchGuidelines],
      ["writing", "worker", japaneseWritingGuidelines],
      ["writing", "reviewer", independentReviewGuidelines],
    ] as const) {
      const run = await f.harness.create({
        kind,
        access: kind === "research" ? "read-only" : "change",
        objective: `Check ${kind} guidance`,
        dataClass: "private",
      });
      const owned = f.store.claim(run.id);
      const task = fixtureTask(role, role !== "reviewer");
      owned.tasks = [task];
      const signal = new AbortController().signal;
      const mcp = new McpTools(
        f.config,
        f.p,
        new Sandbox(f.config.execution),
        f.root,
        signal,
      );
      await executor.invoke(owned, task, signal, mcp);
      assert.ok(runtime.requests.at(-1)!.system.includes(expected));
      if (role === "reviewer")
        assert.ok(
          runtime.requests.at(-1)!.system.includes(japaneseWritingGuidelines),
        );
      await mcp.close();
      f.store.release(owned);
    }
  } finally {
    await f.cleanup();
  }
});
