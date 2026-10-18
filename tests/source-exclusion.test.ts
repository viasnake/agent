import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { Application } from "../src/application.js";
import { Conversations } from "../src/conversations.js";
import { Sandbox } from "../src/sandbox.js";
import { TaskTools } from "../src/tools.js";
import { storePreparedText } from "../src/documents.js";
import { saveImage } from "../src/images.js";
import { workspaceDiff } from "../src/workspace.js";
import {
  AgentError,
  type ConversationContext,
  type ImageReference,
  type Task,
} from "../src/types.js";
import { sha256 } from "../src/util.js";
import { fixture, ScriptedRuntime, gitWorkspace } from "./helpers.js";

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
    const pdfPrepared = await Promise.all(
      ["pages=1", "pages=2"].map((selector, index) =>
        storePreparedText(
          f.p,
          "report.pdf",
          "pdf",
          selector,
          pdfRawBytes,
          `Selected PDF page ${index + 1}\n`,
          `pages ${index + 1}-${index + 1}`,
          false,
        ),
      ),
    );
    const pdfReferenceIds = pdfPrepared.map(({ reference }) => reference.id);
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
            rawSha256: sha256(pdfRawBytes),
            selectedSha256: sha256(selected),
          },
        );
      }),
    );
    const pageBytes = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const pageSha256 = sha256(pageBytes);
    const pageImage: ImageReference = {
      ...(await saveImage(
        f.p,
        "report-page-1.png",
        pageBytes,
        "public",
        false,
      )),
      documentId: pdfReferenceIds[0],
    };
    const queuedPageBytes = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const queuedPage = await storePreparedText(
      f.p,
      "report.pdf",
      "pdf",
      "pages=3",
      pdfRawBytes,
      "Queued page three\n",
      "page 3",
      false,
    );
    const queuedImage = {
      ...(await saveImage(
        f.p,
        "report-page-3.png",
        queuedPageBytes,
        "public",
        false,
      )),
      documentId: queuedPage.reference.id,
    };
    owned.images = [pageImage];
    owned.preparedInputs = pdfPrepared.map((input) => input.reference);
    app.session.images = [pageImage];
    app.session.queue = [
      {
        id: "queued-pdf",
        text: "continue with queued PDF",
        mode: "next",
        images: [pageImage, queuedImage],
        documents: [
          {
            ...pdfPrepared[0]!.reference,
            imageIds: [pageImage.id],
          },
          { ...queuedPage.reference, imageIds: [queuedImage.id] },
        ],
        previewBinding: "stale-preview",
        previewConfigHash: "stale-config",
      },
    ];
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

    const stale = await app.previewSourceExclusion(source.id);
    app.session.context!.excludedSourceUrls = ["https://stale.example/"];
    await assert.rejects(
      app.excludeSource(source.id, stale.binding),
      (error) => error instanceof AgentError && error.code === "SOURCE_BINDING",
    );
    delete app.session.context!.excludedSourceUrls;
    app.save();

    const preview = await app.previewSourceExclusion(source.id);
    assert.ok(preview.family.sourceIds.includes(source.id));
    assert.ok(preview.family.sourceIds.includes(identical.id));
    assert.ok(preview.family.sourceIds.includes(sameUrl.id));
    assert.ok(preview.family.rawArtifactIds.includes(raw.id));
    assert.ok(preview.family.hashes.includes(sha256(rawBytes)));
    await app.excludeSource(source.id, preview.binding);
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
    const pdfPreview = await app.previewSourceExclusion(pdfSources[0]!.id);
    assert.ok(
      pdfPreview.family.sourceIds.includes(pdfSources[1]!.id),
      "a different page selector from the same PDF belongs to the same family",
    );
    assert.ok(pdfPreview.family.imageIds.includes(pageImage.id));
    assert.ok(pdfPreview.family.hashes.includes(pageSha256));
    assert.ok(pdfPreview.family.hashes.includes(sha256(pdfRawBytes)));
    assert.ok(pdfPreview.family.hashes.includes(queuedImage.sha256));
    assert.ok(pdfPreview.family.imageIds.includes(queuedImage.id));
    const mutableRun = f.store.claim(run.id);
    app.session.images = [];
    app.session.queue[0]!.images = [];
    mutableRun.images = [];
    f.store.save(mutableRun, "remove_queued_image");
    const changedMembership = await app.previewSourceExclusion(
      pdfSources[0]!.id,
    );
    assert.notEqual(changedMembership.binding, pdfPreview.binding);
    app.session.images = [pageImage];
    app.session.queue[0]!.images = [pageImage, queuedImage];
    mutableRun.images = [pageImage];
    f.store.save(mutableRun, "restore_queued_image");
    f.store.release(mutableRun);
    const currentPdfPreview = await app.previewSourceExclusion(
      pdfSources[0]!.id,
    );
    assert.ok(currentPdfPreview.family.imageIds.includes(pageImage.id));
    await app.excludeSource(pdfSources[0]!.id, currentPdfPreview.binding);
    assert.deepEqual(app.session.images, []);
    assert.deepEqual(app.session.queue[0]!.documents, []);
    assert.deepEqual(app.session.queue[0]!.images, []);
    assert.equal(app.session.queue[0]!.previewBinding, undefined);
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
    await assert.rejects(
      app.previewSourceExclusion(source.id),
      (error) => error instanceof AgentError && error.code === "SOURCE",
    );
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("excluded raw, selected and image copies disappear from inherited work projections, not original baseline", async () => {
  const f = await fixture(
    new ScriptedRuntime(async () => {
      throw new Error("No provider");
    }),
  );
  let app: Application | undefined;
  try {
    const raw = Buffer.from("FAMILY_RAW_SECRET\nsecond line\n");
    const text = "FAMILY_SELECTED_SECRET\n";
    const imageBytes = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    const origin = await gitWorkspace(f.root, {
      "raw-secret.txt": raw.toString(),
      "selected-secret.txt": text,
      "image-secret.png": "tracked image placeholder",
      "keep.txt": "Keep this public text\n",
    });
    await writeFile(join(origin, "image-secret.png"), imageBytes);
    app = new Application(f.config, f.p, f.store, origin, async () => {
      throw new Error("No provider");
    });
    await app.initialize();
    const input = await storePreparedText(
      f.p,
      "report.txt",
      "text",
      "lines=1",
      raw,
      text,
      "line 1",
      true,
    );
    const image = {
      ...(await saveImage(f.p, "page.png", imageBytes, "private", false)),
      documentId: input.reference.id,
    };
    input.images = [image];
    input.reference.imageIds = [image.id];
    const run = await f.harness.create({
      kind: "research",
      access: "read-only",
      objective: "Read evidence",
      workspace: origin,
      preparedInputs: [input],
      conversationId: app.session.id,
      dataClass: "private",
    });
    app.conversations.link(app.session, run);
    const source = f.store
      .artifacts(run.id)
      .find(
        (artifact) =>
          artifact.kind === "source" &&
          artifact.metadata.sourceId === input.reference.id,
      )!;
    assert.ok(source);
    const sourceWork = join(f.store.runDir(run.id), "work");
    assert.equal(
      await readFile(join(sourceWork, "raw-secret.txt"), "utf8"),
      raw.toString(),
    );
    const preview = await app.previewSourceExclusion(source.id);
    assert.ok(preview.family.hashes.includes(image.sha256));
    await app.excludeSource(source.id, preview.binding);
    const continued = await f.harness.create({
      kind: "research",
      access: "read-only",
      objective: "Continue safely",
      workspace: origin,
      parentRunId: run.id,
      conversationId: app.session.id,
      contextState: app.session.context,
      dataClass: "private",
    });
    const owner = f.store.claim(continued.id);
    const tools = new TaskTools(
      f.config,
      f.store,
      owner,
      {
        id: "inspect",
        objective: "Inspect remaining files",
        role: "worker",
        dependsOn: [],
        model: "worker",
        write: false,
        state: "running",
        attempts: 0,
      },
      join(f.store.runDir(continued.id), "work"),
      new Sandbox(f.config.execution),
    ).all();
    const invoke = (name: string, args: Record<string, unknown>) =>
      tools
        .find((tool) => tool.name === name)!
        .execute(args, new AbortController().signal);
    const listed = await invoke("list_files", {});
    assert.match(listed, /keep.txt/);
    assert.doesNotMatch(
      listed,
      /raw-secret|selected-secret|image-secret|report.txt/,
    );
    for (const path of [
      "raw-secret.txt",
      "selected-secret.txt",
      "image-secret.png",
    ])
      await assert.rejects(invoke("read_file", { path }));
    assert.doesNotMatch(
      await invoke("search_files", { text: "FAMILY_" }),
      /FAMILY_RAW_SECRET|FAMILY_SELECTED_SECRET/,
    );
    const delta = await workspaceDiff(
      f.store.runDir(continued.id),
      f.config.limits.maxWorkspaceBytes,
    );
    assert.doesNotMatch(
      delta.patch,
      /FAMILY_|raw-secret|selected-secret|image-secret/,
    );
    assert.equal(
      await readFile(join(origin, "raw-secret.txt"), "utf8"),
      raw.toString(),
    );
    assert.equal(
      await readFile(
        join(f.store.runDir(run.id), "baseline", "raw-secret.txt"),
        "utf8",
      ),
      raw.toString(),
    );
    assert.equal(
      await readFile(join(sourceWork, "raw-secret.txt"), "utf8"),
      raw.toString(),
    );
    f.store.release(owner);
  } finally {
    await app?.close();
    await f.cleanup();
  }
});
