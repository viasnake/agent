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
import { AgentError } from "../src/types.js";
import { guardModelStream } from "../src/runtime/transport.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";

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

function pngChunks(bytes: Buffer): Map<string, Buffer[]> {
  const chunks = new Map<string, Buffer[]>();
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    chunks.set(type, [...(chunks.get(type) ?? []), payload]);
    offset += length + 12;
  }
  return chunks;
}

function pngCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Buffer): Buffer {
  const typeBytes = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(Buffer.concat([typeBytes, payload])));
  return Buffer.concat([length, typeBytes, payload, crc]);
}

async function apngFixture(): Promise<Buffer> {
  const frame1 = await sharp({
    create: { width: 1, height: 1, channels: 4, background: "red" },
  })
    .png()
    .toBuffer();
  const frame2 = await sharp({
    create: { width: 1, height: 1, channels: 4, background: "blue" },
  })
    .png()
    .toBuffer();
  const chunks1 = pngChunks(frame1);
  const chunks2 = pngChunks(frame2);
  const control = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(1, 4);
    data.writeUInt32BE(1, 8);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(10, 22);
    return data;
  };
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(2, 0);
  animation.writeUInt32BE(0, 4);
  const frameData = Buffer.alloc(4 + chunks2.get("IDAT")![0]!.length);
  frameData.writeUInt32BE(2, 0);
  chunks2.get("IDAT")![0]!.copy(frameData, 4);
  return Buffer.concat([
    frame1.subarray(0, 8),
    pngChunk("IHDR", chunks1.get("IHDR")![0]!),
    pngChunk("acTL", animation),
    pngChunk("fcTL", control(0)),
    pngChunk("IDAT", chunks1.get("IDAT")![0]!),
    pngChunk("fcTL", control(1)),
    pngChunk("fdAT", frameData),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
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

test("rejects APNG animation control chunks", async () => {
  const apng = await apngFixture();
  const metadata = await sharp(apng).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.pages ?? 1, 1);
  await assert.rejects(validateImage(apng), {
    code: "IMAGE_DIMENSIONS",
  });
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
  f.config.models.worker!.tools = false;
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

test("transport guards count repeated image history and reject non-image SDK models", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  const [png] = await fixtures();
  const encoded = png!.toString("base64");
  const context = {
    messages: [
      {
        role: "user",
        content: [
          { type: "image", data: encoded, mimeType: "image/png" },
          { type: "image", data: encoded, mimeType: "image/png" },
        ],
      },
    ],
  };
  const observations: unknown[][] = [];
  const runGuard = async (input: string[]) => {
    const model = {
      id: "worker-fixture",
      provider: "agent-compatible",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:12345/v1",
      maxTokens: 32,
      input,
    } as unknown as Model<Api>;
    const runtime = {
      streamSimple: () => {
        throw new Error("No provider dispatch in guard test");
      },
    } as unknown as ModelRuntime;
    const request = {
      model: "worker",
      signal: new AbortController().signal,
      beforeRequest: (...args: unknown[]) => {
        observations.push(args);
        return "reservation";
      },
      onEvent: () => {},
      afterRequest: () => {},
    } as unknown as import("../src/types.js").RuntimeRequest;
    const checkFailure = guardModelStream(
      runtime,
      model,
      f.config.connections.local!,
      request,
      1,
    );
    const stream = (
      runtime as unknown as {
        streamSimple: (
          model: Model<Api>,
          context: unknown,
          options: object,
        ) => AsyncIterable<unknown>;
      }
    ).streamSimple(model, context, {});
    for await (const _event of stream) {
    }
    return checkFailure;
  };
  try {
    const supportedFailure = await runGuard(["text", "image"]);
    assert.deepEqual(observations[0]!.slice(1), [2, 16384]);
    assert.ok((observations[0]![0] as number) > 49152);
    assert.throws(supportedFailure);
    const unsupportedFailure = await runGuard(["text"]);
    assert.equal(observations.length, 1);
    assert.throws(unsupportedFailure, (error: unknown) => {
      assert.ok(error instanceof AgentError);
      assert.equal(error.code, "NO_IMAGE_MODEL");
      return true;
    });
  } finally {
    await f.cleanup();
  }
});

test("preview lists only authorized image recipients and preserves restricted disclosure", async () => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  f.config.models.worker!.images = false;
  f.config.models.workerNoTools = {
    ...f.config.models.worker!,
    id: "worker-no-tools",
    images: true,
    tools: false,
  };
  f.config.models.workerWithTools = {
    ...f.config.models.worker!,
    id: "worker-with-tools",
    images: true,
    tools: true,
  };
  const [png] = await fixtures();
  await writeFile(join(f.root, "evidence.png"), png!);
  await writeFile(join(f.root, "note.txt"), "Text evidence.");
  const app = new Application(
    f.config,
    f.p,
    f.store,
    f.root,
    async () => new ScriptedRuntime(async () => "unused"),
  );
  try {
    await app.initialize();
    const imageOnly = await app.previewInput("Inspect @evidence.png");
    assert.ok(
      imageOnly.destinations.some((line) => line.startsWith("workerNoTools")),
    );
    assert.ok(
      imageOnly.destinations.some((line) => line.startsWith("workerWithTools")),
    );
    assert.ok(
      imageOnly.destinations.every((line) => !line.startsWith("worker —")),
    );
    assert.equal(imageOnly.dataClass, "private");
    assert.equal(imageOnly.localOnly, false);
    const mixed = await app.previewInput(
      "Compare @evidence.png with @note.txt",
    );
    assert.ok(
      mixed.destinations.some((line) => line.startsWith("workerWithTools")),
    );
    assert.ok(
      mixed.destinations.every((line) => !line.startsWith("workerNoTools")),
    );
    const restricted = await saveImage(
      f.p,
      "restricted.png",
      png!,
      "restricted",
      false,
    );
    app.session.images = [restricted];
    const retained = await app.previewInput("Describe the retained image");
    assert.equal(retained.dataClass, "restricted");
    assert.equal(retained.localOnly, false);
    app.session.model = "worker";
    app.setDraft("Inspect @evidence.png");
    await assert.rejects(
      app.submit("Inspect @evidence.png"),
      (error: unknown) => {
        assert.ok(error instanceof AgentError);
        assert.equal(error.code, "NO_IMAGE_MODEL");
        assert.match(error.message, /workerWithTools|workerNoTools/);
        return true;
      },
    );
    assert.equal(app.session.draft, "Inspect @evidence.png");
    assert.equal(app.session.queue.length, 0);
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("image chat with text evidence keeps the read_source tool available", async () => {
  let app!: Application;
  let evidence = "";
  const runtime = new ScriptedRuntime(async (request) => {
    const source = request.tools.find((tool) => tool.name === "read_source");
    assert.ok(source);
    const sourceId = app.currentRun()!.inputs[0]!;
    evidence = await source.execute({ id: sourceId }, request.signal);
    assert.equal(request.images?.length, 1);
    return "Compared the image with the attached source.";
  });
  const f = await fixture(runtime);
  f.config.models.worker!.images = true;
  const [png] = await fixtures();
  await writeFile(join(f.root, "evidence.png"), png!);
  await writeFile(join(f.root, "note.txt"), "Text evidence for comparison.");
  app = new Application(f.config, f.p, f.store, f.root, async () => runtime);
  try {
    await app.initialize();
    await app.submit("Compare @evidence.png with @note.txt");
    await app.waitForIdle();
    assert.match(evidence, /Text evidence for comparison/);
    assert.equal(app.currentRun()?.state, "succeeded");
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("image model policy rejects before dispatch and local-only input excludes remote connections", async () => {
  const bytes = await fixtures();
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  const restricted = await saveImage(
    f.p,
    "restricted.png",
    bytes[0]!,
    "restricted",
    false,
  );
  const localOnlyRef = await saveImage(
    f.p,
    "local-only.png",
    bytes[0]!,
    "private",
    true,
  );
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.AGENT_TEST_IMAGE_KEY;
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
      images: [restricted],
    });
    const disabledResult = await imageDisabled.execute(disabledRun.id);
    assert.notEqual(disabledResult.state, "succeeded");
    assert.match(disabledResult.reason ?? "", /No authorized image-capable/);
    assert.equal(fetches, 0);

    f.config.models.worker!.images = true;
    f.config.models.worker!.tools = false;
    f.config.connections.local!.type = "compatible";
    f.config.connections.local!.secretEnv = "AGENT_TEST_IMAGE_KEY";
    f.config.connections.local!.endpoint = "https://image-fixture.invalid/v1";
    f.config.connections.local!.billing = "api";
    f.config.connections.local!.maxRequestUsd = 1;
    f.config.connections.local!.allowedData = ["public", "private"];
    f.config.limits.maxApiUsd = 1;
    process.env.AGENT_TEST_IMAGE_KEY = "test-only-not-a-real-key";
    for (const image of [restricted, localOnlyRef]) {
      const protectedRun = await imageDisabled.create({
        kind: "chat",
        objective: "protected image policy",
        images: [image],
      });
      const protectedResult = await imageDisabled.execute(protectedRun.id);
      assert.notEqual(protectedResult.state, "succeeded");
      assert.match(protectedResult.reason ?? "", /No authorized image-capable/);
    }
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.AGENT_TEST_IMAGE_KEY;
    else process.env.AGENT_TEST_IMAGE_KEY = originalKey;
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

test("Pi continuation sends prior image history only once", async (t) => {
  const f = await fixture(new ScriptedRuntime(async () => "unused"));
  f.config.models.worker!.images = true;
  f.config.models.worker!.tools = false;
  const [png] = await fixtures();
  await writeFile(join(f.root, "first.png"), png!);
  const payloads: Record<string, unknown>[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      payloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return openAiResponse("received");
    },
  );
  const app = new Application(
    f.config,
    f.p,
    f.store,
    f.root,
    async () => new PiRuntime(f.config, f.p),
  );
  try {
    await app.initialize();
    await app.submit("Inspect @first.png");
    await app.waitForIdle();
    await app.submit("Compare the retained image again");
    await app.waitForIdle();
    assert.equal(payloads.length, 2);
    const messages = payloads[1]!.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>> | string;
    }>;
    const images = messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content
            .map((part) => {
              const imageUrl = part.image_url as { url?: string } | undefined;
              return imageUrl?.url?.match(/^data:[^;]+;base64,(.*)$/)?.[1];
            })
            .filter((data): data is string => data !== undefined)
        : [],
    );
    assert.equal(images.length, 1);
    assert.deepEqual(Buffer.from(images[0]!, "base64"), png);
    assert.match(JSON.stringify(messages), /Inspect @first\.png/);
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
