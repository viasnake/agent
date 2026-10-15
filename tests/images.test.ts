import assert from "node:assert/strict";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import test from "node:test";
import { Harness } from "../src/harness.js";
import {
  maxImageBytes,
  maxImagePixels,
  saveImage,
  validateImage,
} from "../src/images.js";
import { Application } from "../src/application.js";
import { PiRuntime } from "../src/runtime/pi.js";
import type { ImageReference } from "../src/types.js";
import { fixture, ScriptedRuntime } from "./helpers.js";

async function fixtures(): Promise<[Buffer, Buffer, Buffer]> {
  const png = await sharp({
    create: {
      width: 2,
      height: 1,
      channels: 3,
      background: { r: 40, g: 80, b: 120 },
    },
  })
    .png()
    .toBuffer();
  const jpeg = await sharp(png).jpeg().toBuffer();
  const webp = await sharp(png).webp().toBuffer();
  return [png, jpeg, webp];
}

test("validates static PNG, JPEG and WebP and rejects malformed, mismatched, animated and oversized input", async () => {
  const [png, jpeg, webp] = await fixtures();
  for (const [bytes, mimeType] of [
    [png, "image/png"],
    [jpeg, "image/jpeg"],
    [webp, "image/webp"],
  ] as const)
    assert.equal((await validateImage(bytes, mimeType)).mimeType, mimeType);
  await assert.rejects(validateImage(png.subarray(0, png.length - 2)));
  await assert.rejects(validateImage(png, "image/jpeg"));
  await assert.rejects(validateImage(Buffer.alloc(maxImageBytes + 1)));
  const tooWide = await sharp({
    create: {
      width: 2049,
      height: 1,
      channels: 3,
      background: "red",
    },
  })
    .png()
    .toBuffer();
  await assert.rejects(validateImage(tooWide));
  assert.ok(maxImagePixels > 0);
  const animated = await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]), {
    raw: { width: 1, height: 2, channels: 4, pageHeight: 1 },
  })
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();
  await assert.rejects(validateImage(animated));
});

function openAiResponse(text: string): Response {
  const chunks = [
    {
      id: "image-fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "worker-fixture",
      choices: [{ index: 0, delta: { role: "assistant", content: text } }],
    },
    {
      id: "image-fixture",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("Pi receives original image bytes in order alongside the text prompt", async (t) => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  const bytes = await fixtures();
  f.config.models.worker!.images = true;
  const refs: ImageReference[] = [];
  for (const [index, data] of bytes.entries())
    refs.push(
      await saveImage(
        f.p,
        index === 0 ? "image.png" : index === 1 ? "image.jpg" : "image.webp",
        data,
        "private",
        false,
      ),
    );
  const payloads: Record<string, unknown>[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return openAiResponse("received");
    },
  );
  try {
    const harness = new Harness(
      f.config,
      f.p,
      f.store,
      new PiRuntime(f.config, f.p),
    );
    const run = await harness.create({
      kind: "chat",
      objective: "Compare the attached images and describe their order.",
      images: refs,
    });
    const result = await harness.execute(run.id);
    assert.equal(result.state, "succeeded", result.reason);
    const message = (
      payloads[0]!.messages as Array<{
        role: string;
        content: unknown;
      }>
    ).findLast((item) => item.role === "user")!;
    const parts = message.content as Array<Record<string, unknown>>;
    const imageData = parts
      .map((part) => {
        const imageUrl = part.image_url as { url?: string } | undefined;
        return imageUrl?.url?.match(/^data:[^;]+;base64,(.*)$/)?.[1];
      })
      .filter((value): value is string => value !== undefined)
      .map((value) => Buffer.from(value, "base64"));
    assert.deepEqual(imageData, bytes);
    assert.match(
      parts.map((part) => String(part.text ?? "")).join(" "),
      /attached images/i,
    );
    const stored = JSON.stringify(f.store.get(run.id));
    assert.equal(stored.includes(bytes[0]!.toString("base64")), false);
    assert.equal(
      JSON.stringify(f.store.events(run.id)).includes(
        bytes[0]!.toString("base64"),
      ),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("image model policy rejects before dispatch and local-only input excludes remote connections", async () => {
  const bytes = await fixtures();
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  const ref = await saveImage(f.p, "policy.png", bytes[0]!, "restricted", true);
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches++;
    return openAiResponse("unexpected");
  };
  try {
    const imageDisabled = new Harness(
      f.config,
      f.p,
      f.store,
      new PiRuntime(f.config, f.p),
    );
    const disabledRun = await imageDisabled.create({
      kind: "chat",
      objective: "image policy",
      images: [ref],
    });
    const disabledResult = await imageDisabled.execute(disabledRun.id);
    assert.notEqual(disabledResult.state, "succeeded");
    assert.match(disabledResult.reason ?? "", /No authorized image-capable/);
    assert.equal(fetches, 0);

    f.config.models.worker!.images = true;
    f.config.connections.local!.type = "compatible";
    f.config.connections.local!.secretEnv = "IMAGE_TEST_MISSING";
    const localOnly = new Harness(
      f.config,
      f.p,
      f.store,
      new PiRuntime(f.config, f.p),
    );
    const localOnlyRun = await localOnly.create({
      kind: "chat",
      objective: "restricted image policy",
      images: [ref],
      localOnly: true,
    });
    const localOnlyResult = await localOnly.execute(localOnlyRun.id);
    assert.notEqual(localOnlyResult.state, "succeeded");
    assert.match(localOnlyResult.reason ?? "", /No authorized image-capable/);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await f.cleanup();
  }
});

test("configuration changes invalidate an approved image preview without consuming the draft", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  f.config.models.worker!.images = true;
  const image = await fixtures().then(([png]) => png);
  const path = join(f.root, "preview.png");
  await writeFile(path, image);
  const runtime = new ScriptedRuntime(async () => "unexpected");
  const app = new Application(
    f.config,
    f.p,
    f.store,
    f.root,
    async () => runtime,
  );
  const text = "Inspect @preview.png";
  try {
    await app.initialize();
    app.setDraft(text);
    const preview = await app.previewInput(text);
    f.config.models.worker!.images = false;
    await assert.rejects(app.submit(text, "next", preview), {
      code: "IMAGE_PREVIEW_STALE",
    });
    assert.equal(app.session.draft, text);
    assert.equal(app.session.queue.length, 0);
    assert.equal(runtime.requests.length, 0);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("application queue retains image snapshots after source deletion and restart", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  f.config.models.worker!.images = true;
  const bytes = await fixtures();
  const firstPath = join(f.root, "first.png");
  const secondPath = join(f.root, "second.webp");
  await writeFile(firstPath, bytes[0]!);
  await writeFile(secondPath, bytes[2]!);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const runtime = new ScriptedRuntime(async (request, index) => {
    if (index === 0)
      await Promise.race([
        gate,
        new Promise<void>((_, reject) =>
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            {
              once: true,
            },
          ),
        ),
      ]);
    return "queued image received";
  });
  f.config.models.worker2 = {
    ...f.config.models.worker!,
    id: "worker2-fixture",
  };
  const app = new Application(
    f.config,
    f.p,
    f.store,
    f.root,
    async () => runtime,
  );
  let reopened: Application | undefined;
  try {
    await app.initialize();
    const sessionId = app.session.id;
    await app.submit("Inspect @first.png");
    while (runtime.requests.length < 1)
      await new Promise((resolve) => setTimeout(resolve, 1));
    await app.submit("Inspect @second.webp", "next");
    await unlink(firstPath);
    await unlink(secondPath);
    app.stop();
    await app.waitForIdle();
    assert.equal(app.session.queue.length, 1);
    await app.close();
    reopened = new Application(
      f.config,
      f.p,
      f.store,
      f.root,
      async () => runtime,
    );
    await reopened.initialize();
    reopened.openSession(sessionId);
    assert.equal(reopened.session.queue[0]!.images?.length, 2);
    reopened.startQueue();
    await reopened.waitForIdle();
    assert.equal(runtime.requests[1]!.images?.length, 2);
    assert.deepEqual(
      runtime.requests[1]!.images!.map((image) => image.data),
      [bytes[0], bytes[2]],
    );
    assert.equal(reopened.session.queue.length, 0);
    assert.equal(reopened.session.images?.length, 2);
    await reopened.compact();
    reopened.session.model = "worker2";
    await reopened.submit("Compare the retained images again");
    await reopened.waitForIdle();
    assert.equal(runtime.requests[2]!.model, "worker2");
    assert.equal(runtime.requests[2]!.images?.length, 2);
  } finally {
    release();
    if (reopened) await reopened.close();
    else await app.close();
    await f.cleanup();
  }
});
