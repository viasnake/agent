import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import sharp from "sharp";
import { GoogleAuth } from "google-auth-library";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import {
  fauxProvider,
  normalizeContext,
  type TranscriptContext,
  type ImageContent,
} from "@earendil-works/pi-ai";
import { fixture, answer, until } from "./support.js";
import { modelInput, settingsInput } from "../src/settings.js";
import { modelProvider } from "../src/model-providers.js";
import { validateImage } from "../src/images.js";
import { createServer } from "../src/server.js";

function environment(
  t: TestContext,
  values: Record<string, string | undefined>,
) {
  const saved = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// An AWS event-stream wire fixture exercises SDK framing, serialization, and
// signing, while the mocked HTTP handler prevents any network access.
function eventFrame(name: string, payload: unknown): Buffer {
  const headers = Buffer.concat(
    Object.entries({
      ":message-type": "event",
      ":event-type": name,
      ":content-type": "application/json",
    }).map(([key, value]) => {
      const field = Buffer.alloc(1 + key.length + 1 + 2 + value.length);
      field.writeUInt8(key.length, 0);
      field.write(key, 1);
      field.writeUInt8(7, 1 + key.length);
      field.writeUInt16BE(value.length, 2 + key.length);
      field.write(value, 4 + key.length);
      return field;
    }),
  );
  const body = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(16 + headers.length + body.length);
  frame.writeUInt32BE(frame.length, 0);
  frame.writeUInt32BE(headers.length, 4);
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
  headers.copy(frame, 12);
  body.copy(frame, 12 + headers.length);
  frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4);
  return frame;
}

test("images enter Pi atomically, retain original bytes after file changes, and remain scoped to the conversation", async (t) => {
  const faux = fauxProvider({
    tokensPerSecond: Infinity,
    models: [{ id: "faux-1", input: ["text", "image"] }],
  });
  faux.setResponses([answer("Image received")]);
  const contexts: TranscriptContext[] = [];
  const original = faux.provider.streamSimple;
  const provider = {
    ...faux.provider,
    streamSimple: ((model, context, options) => {
      contexts.push(structuredClone(context));
      return original(model, context, options);
    }) as typeof original,
  };
  const f = await fixture([], { provider });
  t.after(() => f.service.close());
  const bytes = await sharp({
    create: { width: 2048, height: 1, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const { id } = await f.service.create(randomUUID(), "Image fixture");
  const file = await f.service.upload(id, randomUUID(), "image.png", bytes);
  const request = randomUUID();
  await f.service.send(id, request, "Describe the image", false, [file.path]);
  await until(async () => (await f.service.conversation(id)).status === "idle");
  const images: ImageContent[] = [];
  for (const message of contexts[0]!.messages)
    if (Array.isArray(message.content))
      for (const part of message.content)
        if (part.type === "image") images.push(part);
  assert.equal(images.length, 1);
  assert.equal(images[0]!.data, bytes.toString("base64"));
  await f.service.send(id, request, "Describe the image", false, [file.path]);
  assert.equal(contexts.length, 1);
  await writeFile(join(f.root, "work/conversations", id, file.path), "changed");
  const view = await f.service.view(id);
  const imageUrl = view.transcript.flatMap((entry) =>
    entry.messages.flatMap((message) => message.images),
  )[0]!.url;
  const app = await createServer(f.service);
  t.after(() => app.close());
  const headers: Record<string, string> = {
    host: "127.0.0.1:8080",
    origin: "http://127.0.0.1:8080",
  };
  assert.equal((await app.inject({ url: imageUrl, headers })).statusCode, 401);
  const session = await app.inject({ url: "/api/session", headers });
  headers.cookie = session.headers["set-cookie"]!.toString().split(";")[0]!;
  const image = await app.inject({ url: imageUrl, headers });
  assert.equal(image.statusCode, 200);
  assert.deepEqual(image.rawPayload, bytes);
  assert.equal(image.headers["content-type"], "image/png");
  const other = await f.service.create(randomUUID(), "Other fixture");
  assert.equal(
    (await app.inject({ url: imageUrl.replace(id, other.id), headers }))
      .statusCode,
    404,
  );
  assert.ok(!JSON.stringify(view).includes(bytes.toString("base64")));
});

test("invalid images, attachment traversal, and text-only models fail before inference", async (t) => {
  const faux = fauxProvider({ models: [{ id: "faux-1", input: ["text"] }] });
  const f = await fixture([], { provider: faux.provider });
  t.after(() => f.service.close());
  const { id } = await f.service.create(randomUUID(), "Invalid input");
  const corrupt = await f.service.upload(
    id,
    randomUUID(),
    "bad.png",
    Buffer.from("not an image"),
  );
  await assert.rejects(
    f.service.send(id, randomUUID(), "Image", false, [corrupt.path]),
  );
  await assert.rejects(
    f.service.send(id, randomUUID(), "Image", false, [
      "attachments/../outputs/secret.png",
    ]),
  );
  const bytes = await sharp({
    create: { width: 2, height: 1, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const valid = await f.service.upload(id, randomUUID(), "good.png", bytes);
  await assert.rejects(
    f.service.send(id, randomUUID(), "Image", false, [valid.path]),
    /画像入力/,
  );
  await symlink(
    join(f.root, "control/settings-v1.json"),
    join(f.root, "work/conversations", id, "attachments/link.png"),
  );
  await assert.rejects(
    f.service.send(id, randomUUID(), "Image", false, ["attachments/link.png"]),
  );
  assert.equal((await f.service.conversation(id)).requests, 0);
  for (const format of ["jpeg", "webp"] as const) {
    const image = await sharp(bytes)[format]().toBuffer();
    assert.equal(
      (await validateImage(image, `image/${format}`)).mimeType,
      `image/${format}`,
    );
  }
  const large = await sharp({
    create: { width: 2049, height: 1, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  await assert.rejects(validateImage(large));
});

test("provider settings keep credentials private and do not move keys to another destination", async (t) => {
  const f = await fixture([], { noModel: true });
  t.after(() => f.service.close());
  const {
    hostId: _,
    schemaVersion: __,
    ...base
  } = f.service.settings.snapshot();
  const id = randomUUID();
  const initial = settingsInput.parse({
    ...base,
    models: [{ id, provider: "openai", key: "private-fixture-key" }],
    defaultModel: id,
  });
  await f.service.saveSettings(initial);
  const next = {
    ...initial,
    revision: initial.revision + 1,
    models: [{ id, provider: "anthropic" }],
  };
  await f.service.saveSettings(next);
  assert.equal(f.service.settings.snapshot().models[0]!.key, undefined);
  assert.ok(
    !JSON.stringify(f.service.management()).includes("private-fixture-key"),
  );
  for (const provider of [
    "anthropic",
    "google",
    "google-vertex",
    "amazon-bedrock",
  ] as const)
    assert.ok(f.service.modelOptions().catalogs[provider].length > 0);
  assert.throws(() =>
    modelInput.parse({ id, provider: "google-vertex", auth: "adc" }),
  );
  assert.throws(() =>
    modelInput.parse({
      id,
      provider: "amazon-bedrock",
      auth: "oauth",
      region: "us-east-1",
    }),
  );
});

for (const provider of ["google-vertex", "amazon-bedrock"] as const) {
  test(`${provider} uses native image/tool transport and the configured destination without live access`, async (t) => {
    const f = await fixture([], { noModel: true });
    t.after(() => f.service.close());
    const configId = randomUUID();
    const modelId =
      provider === "google-vertex"
        ? "gemini-2.5-flash"
        : "anthropic.claude-sonnet-4-5-20250929-v1:0";
    const model = modelInput.parse({
      id: configId,
      provider,
      ...(provider === "google-vertex"
        ? { auth: "adc", project: "fixture-project", location: "global" }
        : { auth: "aws", region: "us-west-2" }),
    });
    const {
      hostId: _,
      schemaVersion: __,
      ...base
    } = f.service.settings.snapshot();
    await f.service.saveSettings({
      ...base,
      models: [model],
      defaultModel: configId,
    });
    const { id } = await f.service.create(
      randomUUID(),
      "Cloud fixture",
      configId,
      modelId,
    );
    const bytes = await sharp({
      create: { width: 128, height: 1, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const image = await f.service.upload(id, randomUUID(), "input.png", bytes);
    const payloads: Record<string, any>[] = [];
    if (provider === "google-vertex") {
      environment(t, {
        GOOGLE_VERTEX_BASE_URL: "https://unexpected.invalid",
        GOOGLE_CLOUD_PROJECT: "wrong-project",
        GOOGLE_CLOUD_LOCATION: "us-west1",
        GOOGLE_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
      });
      t.mock.method(
        GoogleAuth.prototype,
        "getRequestHeaders",
        async () => new Headers({ authorization: "Bearer fixture-adc" }),
      );
      t.mock.method(
        globalThis,
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request =
            input instanceof Request ? input : new Request(input, init);
          assert.match(
            request.url,
            /^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/fixture-project\/locations\/global\/publishers\/google\/models\/gemini-2\.5-flash:streamGenerateContent/,
          );
          assert.equal(
            request.headers.get("authorization"),
            "Bearer fixture-adc",
          );
          payloads.push(JSON.parse(await request.text()));
          const part =
            payloads.length === 1
              ? { functionCall: { name: "read", args: { path: image.path } } }
              : { text: "Cloud fixture complete" };
          return new Response(
            `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [part] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 12, totalTokenCount: 27 } })}\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      );
    } else {
      environment(t, {
        AWS_ACCESS_KEY_ID: "fixture-id",
        AWS_SECRET_ACCESS_KEY: "fixture-secret",
        AWS_SESSION_TOKEN: undefined,
        AWS_PROFILE: undefined,
        AWS_REGION: "eu-west-1",
        AWS_MAX_ATTEMPTS: "9",
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "https://unexpected.invalid",
        AWS_BEARER_TOKEN_BEDROCK: "unused-token",
      });
      const client = new BedrockRuntimeClient({ region: "us-west-2" });
      const handler = Object.getPrototypeOf(client.config.requestHandler);
      client.destroy();
      t.mock.method(
        handler,
        "handle",
        async (request: {
          hostname: string;
          headers: Record<string, string>;
          body: Uint8Array;
        }) => {
          assert.equal(
            request.hostname,
            "bedrock-runtime.us-west-2.amazonaws.com",
          );
          assert.match(
            request.headers.authorization!,
            /^AWS4-HMAC-SHA256 Credential=fixture-id\//,
          );
          payloads.push(JSON.parse(Buffer.from(request.body).toString("utf8")));
          const parts: [string, unknown][] =
            payloads.length === 1
              ? [
                  [
                    "contentBlockStart",
                    {
                      contentBlockIndex: 0,
                      start: {
                        toolUse: { toolUseId: "fixture-tool", name: "read" },
                      },
                    },
                  ],
                  [
                    "contentBlockDelta",
                    {
                      contentBlockIndex: 0,
                      delta: {
                        toolUse: {
                          input: JSON.stringify({ path: image.path }),
                        },
                      },
                    },
                  ],
                ]
              : [
                  [
                    "contentBlockDelta",
                    {
                      contentBlockIndex: 0,
                      delta: { text: "Cloud fixture complete" },
                    },
                  ],
                ];
          return {
            response: {
              statusCode: 200,
              headers: { "content-type": "application/vnd.amazon.eventstream" },
              body: Readable.from([
                eventFrame("messageStart", { role: "assistant" }),
                ...parts.map(([name, data]) => eventFrame(name, data)),
                eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
                eventFrame("messageStop", {
                  stopReason: payloads.length === 1 ? "tool_use" : "end_turn",
                }),
                eventFrame("metadata", {
                  usage: { inputTokens: 15, outputTokens: 12, totalTokens: 27 },
                }),
              ]),
            },
          };
        },
      );
    }
    await f.service.send(
      id,
      randomUUID(),
      "Inspect image and read the attached image file",
      false,
      [image.path],
    );
    await until(
      async () => (await f.service.conversation(id)).status !== "running",
    );
    assert.equal(
      (await f.service.conversation(id)).status,
      "idle",
      (await f.service.conversation(id)).detail,
    );
    assert.equal(payloads.length, 2);
    assert.equal((await f.service.conversation(id)).requests, 2);
    const toolResults = (await f.service.view(id)).transcript.flatMap((entry) =>
      entry.messages.filter((message) => message.role === "toolResult"),
    );
    assert.equal(toolResults.length, 1);
    assert.equal(toolResults[0]!.isError, false);
    assert.equal(toolResults[0]!.images.length, 1);
    for (const [index, payload] of payloads.entries()) {
      const images =
        provider === "google-vertex"
          ? payload.contents
              .flatMap((message: any) => message.parts)
              .filter((part: any) => part.inlineData)
              .map((part: any) => part.inlineData.data)
          : payload.messages
              .flatMap((message: any) => message.content)
              .filter((part: any) => part.image)
              .map((part: any) => part.image.source.bytes);
      assert.deepEqual(
        images,
        Array(provider === "google-vertex" && index === 1 ? 2 : 1).fill(
          bytes.toString("base64"),
        ),
      );
    }
    if (provider === "amazon-bedrock") {
      const result = payloads[1]!.messages
        .flatMap((message: any) => message.content)
        .find((part: any) => part.toolResult).toolResult;
      assert.equal(
        result.content[0].image.source.bytes,
        bytes.toString("base64"),
      );
    }
  });
}

test("Bedrock refuses truncated tool calls and disables AWS inference retries", async (t) => {
  environment(t, {
    AWS_ACCESS_KEY_ID: "fixture-id",
    AWS_SECRET_ACCESS_KEY: "fixture-secret",
    AWS_PROFILE: undefined,
    AWS_SESSION_TOKEN: undefined,
    AWS_MAX_ATTEMPTS: "9",
  });
  const config = modelInput.parse({
    id: randomUUID(),
    provider: "amazon-bedrock",
    auth: "aws",
    region: "us-west-2",
  });
  const provider = modelProvider(config);
  const model = provider
    .getModels()
    .find((m) => m.id === "anthropic.claude-sonnet-4-5-20250929-v1:0")!;
  const client = new BedrockRuntimeClient({ region: "us-west-2" });
  const handler = Object.getPrototypeOf(client.config.requestHandler);
  client.destroy();
  let mode = "incomplete",
    calls = 0;
  t.mock.method(handler, "handle", async () => {
    calls++;
    return {
      response:
        mode === "http"
          ? {
              statusCode: 429,
              headers: {
                "content-type": "application/json",
                "x-amzn-errortype": "ThrottlingException",
              },
              body: Readable.from(['{"message":"fixture"}']),
            }
          : {
              statusCode: 200,
              headers: { "content-type": "application/vnd.amazon.eventstream" },
              body: Readable.from([
                eventFrame("messageStart", { role: "assistant" }),
                eventFrame("contentBlockStart", {
                  contentBlockIndex: 0,
                  start: { toolUse: { toolUseId: "partial", name: "read" } },
                }),
                eventFrame("contentBlockDelta", {
                  contentBlockIndex: 0,
                  delta: { toolUse: { input: '{"path":' } },
                }),
              ]),
            },
    };
  });
  for (const scenario of ["incomplete", "http"]) {
    mode = scenario;
    const result = await provider
      .streamSimple(
        model,
        normalizeContext({
          messages: [
            { role: "user", content: "Fixture", timestamp: Date.now() },
          ],
        }),
      )
      .result();
    assert.equal(result.stopReason, "error");
    assert.deepEqual(result.content, []);
  }
  assert.equal(calls, 2);
});

test("Bedrock uses the selected private token or AWS profile instead of ambient credentials", async (t) => {
  const f = await fixture([], { noModel: true });
  t.after(() => f.service.close());
  const path = join(f.root, "control/aws-credentials");
  await writeFile(
    path,
    "[fixture-profile]\naws_access_key_id = profile-fixture\naws_secret_access_key = profile-secret\n",
    { mode: 0o600 },
  );
  environment(t, {
    AWS_ACCESS_KEY_ID: "ambient-id",
    AWS_SECRET_ACCESS_KEY: "ambient-secret",
    AWS_PROFILE: undefined,
    AWS_SESSION_TOKEN: undefined,
    AWS_SHARED_CREDENTIALS_FILE: path,
    AWS_CONFIG_FILE: join(f.root, "missing-config"),
    AWS_BEARER_TOKEN_BEDROCK: "ambient-token",
    AWS_AUTH_SCHEME_PREFERENCE: "httpBearerAuth",
  });
  const client = new BedrockRuntimeClient({ region: "us-west-2" });
  const handler = Object.getPrototypeOf(client.config.requestHandler);
  client.destroy();
  let token = false,
    calls = 0;
  t.mock.method(
    handler,
    "handle",
    async (request: { headers: Record<string, string> }) => {
      calls++;
      const authorization = Object.entries(request.headers).find(
        ([name]) => name.toLowerCase() === "authorization",
      )?.[1];
      if (token) assert.equal(authorization, "Bearer private-token");
      else
        assert.match(
          authorization!,
          /^AWS4-HMAC-SHA256 Credential=profile-fixture\//,
        );
      return {
        response: {
          statusCode: 200,
          headers: { "content-type": "application/vnd.amazon.eventstream" },
          body: Readable.from([
            eventFrame("messageStart", { role: "assistant" }),
            eventFrame("contentBlockDelta", {
              contentBlockIndex: 0,
              delta: { text: "Fixture" },
            }),
            eventFrame("contentBlockStop", { contentBlockIndex: 0 }),
            eventFrame("messageStop", { stopReason: "end_turn" }),
            eventFrame("metadata", {
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            }),
          ]),
        },
      };
    },
  );
  for (const method of ["aws", "api_key"]) {
    token = method === "api_key";
    const config = modelInput.parse({
      id: randomUUID(),
      provider: "amazon-bedrock",
      auth: method,
      region: "us-west-2",
      profile: "fixture-profile",
      ...(token ? { key: "private-token" } : {}),
    });
    const provider = modelProvider(config);
    const model = provider
      .getModels()
      .find(
        (model) => model.id === "anthropic.claude-sonnet-4-5-20250929-v1:0",
      )!;
    const result = await provider
      .streamSimple(
        model,
        normalizeContext({
          messages: [
            { role: "user", content: "Fixture", timestamp: Date.now() },
          ],
        }),
      )
      .result();
    assert.equal(result.stopReason, "stop");
  }
  assert.equal(calls, 2);
});
