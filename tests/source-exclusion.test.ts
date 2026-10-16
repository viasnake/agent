import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Application } from "../src/application.js";
import { Conversations } from "../src/conversations.js";
import { Sandbox } from "../src/sandbox.js";
import { TaskTools } from "../src/tools.js";
import {
  AgentError,
  type ConversationContext,
  type ImageReference,
  type Task,
} from "../src/types.js";
import { sha256 } from "../src/util.js";
import { fixture, ScriptedRuntime } from "./helpers.js";

test("source exclusion binds and removes a transitive source family from future selectors", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  const app = new Application(f.config, f.p, f.store, f.root, async () => {
    throw new Error("No provider should be created");
  });
  try {
    await app.initialize();
    const run = await f.harness.create({
      kind: "research",
      access: "read-only",
      objective: "Collect public sources",
      dataClass: "public",
      conversationId: app.session.id,
    });
    new Conversations(f.store).link(app.session, run);
    const owned = f.store.claim(run.id);
    const rawBytes = Buffer.from("captured raw bytes");
    const raw = await f.store.artifact(
      owned,
      "sources/raw",
      "source-raw",
      rawBytes,
    );
    const selectedBytes = Buffer.from("selected source text\n");
    const source = await f.store.artifact(
      owned,
      "sources/one.txt",
      "source",
      selectedBytes,
      {
        url: "https://example.com/one",
        rawArtifactId: raw.id,
        rawSha256: sha256(rawBytes),
        selectedSha256: sha256(selectedBytes),
      },
    );
    const identical = await f.store.artifact(
      owned,
      "sources/copy.txt",
      "source",
      selectedBytes,
      {
        url: "https://mirror.example/copy",
        rawSha256: sha256(rawBytes),
        selectedSha256: sha256(selectedBytes),
      },
    );
    const sameUrlBytes = Buffer.from("a later representation\n");
    const sameUrl = await f.store.artifact(
      owned,
      "sources/one-later.txt",
      "source",
      sameUrlBytes,
      {
        url: "https://example.com/one",
        rawSha256: sha256(sameUrlBytes),
        selectedSha256: sha256(sameUrlBytes),
      },
    );
    const pdfRawBytes = Buffer.from("%PDF-same-raw\nPage one\nPage two\n");
    const pdfRaw = await f.store.artifact(
      owned,
      "sources/pdf-raw",
      "source-raw",
      pdfRawBytes,
    );
    const pdfReferenceIds = [
      `doc-${sha256("page one selector")}`,
      `doc-${sha256("page two selector")}`,
    ];
    const pdfSources = await Promise.all(
      pdfReferenceIds.map((sourceId, index) => {
        const selected = Buffer.from(`Selected PDF page ${index + 1}\n`);
        return f.store.artifact(
          owned,
          `inputs/report.pdf::pages=${index + 1}`,
          "source",
          selected,
          {
            sourceId,
            format: "pdf",
            rawArtifactId: pdfRaw.id,
            rawSha256: sha256(pdfRawBytes),
            selectedSha256: sha256(selected),
          },
        );
      }),
    );
    const pageBytes = Buffer.from("PDF page image");
    const pageSha256 = sha256(pageBytes);
    const pageImage: ImageReference = {
      id: `img-${pageSha256}`,
      name: "report-page-1.png",
      mimeType: "image/png",
      width: 1,
      height: 1,
      bytes: pageBytes.length,
      sha256: pageSha256,
      dataClass: "public",
      localOnly: false,
      documentId: pdfReferenceIds[0],
    };
    owned.images = [pageImage];
    owned.contextState = {
      ...app.session.context!,
      sourceIds: [
        source.id,
        identical.id,
        sameUrl.id,
        ...pdfSources.map(({ id }) => id),
      ],
      researchCheckpoint: {
        summary: "Keep this checkpoint",
        searchedScopes: [],
        openQuestions: [],
        decisions: [{ text: "Use the source", sourceIds: [source.id] }],
        author: "model",
        trusted: false,
        updatedAt: Date.now(),
      },
    };
    f.store.save(owned, "fixture_context");
    f.store.release(owned);
    app.session.context = structuredClone(owned.contextState);
    app.session.contextRunId = run.id;
    app.session.latestRunId = run.id;
    app.save();
    const activeRun = f.store.claim(run.id);
    f.store.transition(activeRun, "running");
    f.store.release(activeRun);

    const stale = app.previewSourceExclusion(source.id);
    app.session.context!.excludedSourceUrls = ["https://stale.example/"];
    assert.throws(
      () => app.excludeSource(source.id, stale.binding),
      (error) => error instanceof AgentError && error.code === "SOURCE_BINDING",
    );
    delete app.session.context!.excludedSourceUrls;
    app.save();

    const preview = app.previewSourceExclusion(source.id);
    assert.ok(preview.family.sourceIds.includes(source.id));
    assert.ok(preview.family.sourceIds.includes(identical.id));
    assert.ok(preview.family.sourceIds.includes(sameUrl.id));
    assert.ok(preview.family.rawArtifactIds.includes(raw.id));
    assert.ok(preview.family.hashes.includes(sha256(rawBytes)));
    app.excludeSource(source.id, preview.binding);
    assert.ok(app.session.context!.excludedSourceIds!.includes(source.id));
    assert.ok(app.session.context!.excludedSourceIds!.includes(identical.id));
    assert.ok(app.session.context!.excludedSourceIds!.includes(raw.id));
    assert.ok(
      app.session.context!.researchCheckpoint!.unavailableSourceIds!.includes(
        source.id,
      ),
    );
    assert.deepEqual(
      app.session.context!.researchCheckpoint!.decisions[0]!.sourceIds,
      [],
    );
    const pdfPreview = app.previewSourceExclusion(pdfSources[0]!.id);
    assert.ok(
      pdfPreview.family.sourceIds.includes(pdfSources[1]!.id),
      "a different page selector from the same PDF belongs to the same family",
    );
    assert.ok(pdfPreview.family.imageIds.includes(pageImage.id));
    assert.ok(pdfPreview.family.hashes.includes(pageSha256));
    app.excludeSource(pdfSources[0]!.id, pdfPreview.binding);
    await assert.rejects(
      app.resume(),
      (error) =>
        error instanceof AgentError && error.code === "SOURCE_EXCLUDED",
    );

    const alternateSelector = join(f.root, "reselect.txt");
    await writeFile(alternateSelector, pdfRawBytes);
    await assert.rejects(
      app.previewInput("@reselect.txt::lines=2"),
      (error) =>
        error instanceof AgentError && error.code === "SOURCE_EXCLUDED",
    );

    const contextState = app.session.context as ConversationContext;
    const inherited = await f.harness.create({
      kind: "research",
      access: "read-only",
      objective: "Continue research without excluded evidence",
      dataClass: "public",
      conversationId: app.session.id,
      sourceRunIds: [run.id],
      contextState,
    });
    assert.equal(
      f.store
        .artifacts(inherited.id)
        .filter((artifact) => artifact.kind === "source").length,
      0,
    );
    const inheritedOwned = f.store.claim(inherited.id);
    const task: Task = {
      id: "fixture-task",
      objective: "Continue research",
      role: "worker",
      dependsOn: [],
      model: "worker",
      write: false,
      state: "running",
      attempts: 0,
    };
    const tools = new TaskTools(
      f.config,
      f.store,
      { ...inheritedOwned, contextState },
      task,
      f.store.runDir(inherited.id),
      new Sandbox(f.config.execution),
    );
    await assert.rejects(
      tools
        .all()
        .find((tool) => tool.name === "read_source")!
        .execute({ id: source.id }, new AbortController().signal),
      (error) => error instanceof AgentError && error.code === "SOURCE",
    );
    const evidence = await tools.evidence();
    assert.doesNotMatch(evidence, /example\.com|mirror\.example/);
    f.store.release(inheritedOwned);
    app.newSession();
    assert.throws(
      () => app.previewSourceExclusion(source.id),
      (error) => error instanceof AgentError && error.code === "SOURCE",
    );
  } finally {
    await app.close();
    await f.cleanup();
  }
});
