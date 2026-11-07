import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AgentService } from "./service.js";
import { AppError } from "./security.js";
import { isLocalOrigin } from "./config.js";
import type { Cursor } from "@earendil-works/pi-durable";

const requestId = z.string().uuid();
const identifier = z.object({ id: z.string().uuid() });
type Session = { csrf: string; expires: number };
function inputError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "入力が不正です";
  // Only trusted schema labels reach the UI; paths and values may contain secrets.
  const labels: Record<string, string> = {
    models: "モデル接続",
    mcp: "MCP",
    name: "名前",
    model: "モデル",
    provider: "プロバイダー",
    key: "API キー",
    auth: "認証方式",
    project: "プロジェクト ID",
    location: "ロケーション",
    region: "リージョン",
    profile: "AWS プロファイル",
    transport: "接続方式",
    command: "コマンド",
    args: "引数",
    env: "環境変数",
    envKeep: "環境変数",
    url: "URL",
    bearer: "Bearer Token",
    clientId: "クライアント ID",
    clientSecret: "クライアントシークレット",
    instructions: "共通指示",
    modelRequests: "モデル呼び出し上限",
    runSeconds: "実行時間",
    commandSeconds: "コマンド実行時間",
    title: "会話名",
    text: "メッセージ",
    confirmPaid: "テストの確認",
  };
  const field = issue.path.findLast(
    (part) => typeof part === "string" && Object.hasOwn(labels, part),
  );
  const label =
    issue.path[0] === "models" && field === "name"
      ? "接続名"
      : typeof field === "string"
        ? labels[field]!
        : "入力";
  if (issue.code === "too_big") {
    const unit =
      issue.origin === "string" ? "文字" : issue.origin === "array" ? "件" : "";
    return `${label}は${issue.maximum}${unit}以内です`;
  }
  if (issue.code === "too_small") {
    if (issue.origin === "string") return `${label}を入力してください`;
    return `${label}は${issue.minimum}以上です`;
  }
  if (issue.code === "custom" && field === "command")
    return "コマンドは絶対パスで指定してください";
  if (issue.code === "custom" && field === "url")
    return "URL が不正です（認証には HTTPS が必要です）";
  return `${label}が不正です`;
}
export async function createServer(
  service: AgentService,
  webRoot = fileURLToPath(new URL("../web/", import.meta.url)),
): Promise<FastifyInstance> {
  if (!service.config.server.origins.every(isLocalOrigin))
    throw new Error("Only loopback browser origins are supported");
  const app = Fastify({
    logger: false,
    bodyLimit: 128 * 1024,
    requestTimeout: 30000,
    routerOptions: { maxParamLength: 100 },
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 180, timeWindow: "1 minute" });
  const sessions = new Map<string, Session>();
  const allowedOrigins = new Set(service.config.server.origins),
    hosts = new Set([...allowedOrigins].map((origin) => new URL(origin).host));
  let streams = 0;
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store")
      .header(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
      );
    // QEMU user networking presents host-forwarded connections as 10.0.2.2.
    // Never trust proxy headers to establish the local access boundary.
    const peer = request.ip.replace(/^::ffff:/, "");
    if (!["127.0.0.1", "::1", "10.0.2.2"].includes(peer))
      throw new AppError(403, "ローカル接続のみ利用できます");
    if (request.url === "/healthz") return;
    if (
      !hosts.has(request.headers.host ?? "") ||
      (request.headers.origin && !allowedOrigins.has(request.headers.origin))
    )
      throw new AppError(403, "接続先または Origin が許可されていません");
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      !allowedOrigins.has(request.headers.origin ?? "")
    )
      throw new AppError(403, "Origin の確認が必要です");
    const site = request.headers["sec-fetch-site"];
    if (
      request.url.startsWith("/api/") &&
      site &&
      site !== "same-origin" &&
      site !== "none"
    )
      throw new AppError(403, "同じ画面から操作してください");
    if (!request.url.startsWith("/api/") || request.url === "/api/session")
      return;
    const session = sessions.get(request.cookies.agent_session ?? "");
    if (!session || session.expires < Date.now())
      throw new AppError(401, "接続が切れました。再接続してください");
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.headers["x-csrf-token"] !== session.csrf
    )
      throw new AppError(403, "画面を更新して操作をやり直してください");
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      void reply.code(400).send({ error: inputError(error) });
      return;
    }
    const code =
      error instanceof AppError
        ? error.statusCode
        : (error as { statusCode?: number }).statusCode;
    const status = code && code >= 400 && code <= 599 ? code : 503;
    void reply.code(status).send({
      error:
        error instanceof AppError
          ? service.redact(error.message)
          : status === 413
            ? "入力サイズが上限を超えています"
            : status === 429
              ? "操作が多すぎます。しばらく待ってください"
              : "処理を完了できません。入力・容量・サービスの状態を確認してください",
    });
  });
  app.get("/healthz", async (_request, reply) =>
    reply.code(service.healthy() ? 200 : 503).send({ ok: service.healthy() }),
  );
  // The local page establishes a CSRF session without user credentials.
  app.get("/api/session", async (request, reply) => {
    for (const [token, session] of sessions)
      if (session.expires < Date.now()) sessions.delete(token);
    let token = request.cookies.agent_session;
    if (!token || !sessions.has(token)) {
      if (sessions.size >= 24) sessions.delete(sessions.keys().next().value!);
      token = randomBytes(32).toString("hex");
      sessions.set(token, {
        csrf: randomBytes(32).toString("hex"),
        expires: Date.now() + 12 * 3600 * 1000,
      });
      reply.setCookie("agent_session", token, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: request.protocol === "https",
        maxAge: 12 * 3600,
      });
    }
    return { csrf: sessions.get(token)!.csrf };
  });
  app.get("/api/model-options", async () => service.modelOptions());
  app.get("/api/settings", async () => service.management());
  app.put("/api/settings", async (request) =>
    service.saveSettings(request.body),
  );
  app.post("/api/settings/models/:id/test", async (request) => {
    const { id } = identifier.parse(request.params);
    z.object({ confirmPaid: z.literal(true) })
      .strict()
      .parse(request.body);
    return service.testModel(id);
  });
  app.post("/api/settings/models/:id/oauth", async (request) => {
    const { id } = identifier.parse(request.params);
    z.object({}).strict().parse(request.body);
    return service.modelAuth.begin(id, request.cookies.agent_session!);
  });
  app.get("/api/settings/model-login", async (request) =>
    service.modelAuth.current(request.cookies.agent_session!),
  );
  app.get("/api/settings/model-login/:id", async (request) => {
    const { id } = identifier.parse(request.params);
    return service.modelAuth.status(id, request.cookies.agent_session!);
  });
  app.post("/api/settings/model-login/:id", async (request) => {
    const { id } = identifier.parse(request.params);
    const { url } = z
      .object({ url: z.string().min(1).max(8192) })
      .strict()
      .parse(request.body);
    return service.modelAuth.submit(id, request.cookies.agent_session!, url);
  });
  app.post("/api/settings/model-login/:id/cancel", async (request) => {
    const { id } = identifier.parse(request.params);
    z.object({}).strict().parse(request.body);
    return service.modelAuth.cancel(id, request.cookies.agent_session!);
  });
  app.post("/api/settings/models/:id/disconnect", async (request) => {
    const { id } = identifier.parse(request.params);
    z.object({}).strict().parse(request.body);
    await service.modelAuth.disconnect(id);
    return service.management();
  });
  app.post("/api/settings/mcp/:id/test", async (request) => {
    const { id } = identifier.parse(request.params);
    z.object({}).strict().parse(request.body);
    return service.testMcp(id);
  });
  app.post("/api/settings/mcp/:id/disconnect", async (request) => {
    const { id } = identifier.parse(request.params);
    z.object({}).strict().parse(request.body);
    return service.disconnectMcp(id);
  });
  app.post("/api/settings/mcp/:id/oauth", async (request, reply) => {
    const { id } = identifier.parse(request.params);
    z.object({}).strict().parse(request.body);
    const binding = randomBytes(32).toString("hex");
    const url = await service.remote.begin(
      service.mcpServer(id),
      request.headers.origin!,
      binding,
    );
    // Only this short-lived callback cookie is Lax. The API session stays Strict.
    reply.setCookie("agent_oauth", binding, {
      path: "/oauth/callback",
      httpOnly: true,
      sameSite: "lax",
      secure: request.protocol === "https",
      maxAge: 600,
    });
    return { url };
  });
  app.get("/oauth/callback", async (request, reply) => {
    const query = z
      .object({
        state: z.string().regex(/^[a-f0-9]{64}$/),
        code: z.string().min(1).max(4096),
      })
      .parse(request.query);
    await service.remote.finish(
      query.state,
      query.code,
      request.cookies.agent_oauth ?? "",
      request.headers.host ?? "",
    );
    reply.clearCookie("agent_oauth", { path: "/oauth/callback" });
    return reply.redirect("/?settings=mcp&authorized=1");
  });
  const safe = (value: unknown): unknown => {
    if (typeof value === "string") return service.redact(value);
    if (Array.isArray(value)) return value.map(safe);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, safe(item)]),
      );
    return value;
  };
  app.get("/api/conversations", async () =>
    safe({ conversations: (await service.list()).reverse() }),
  );
  app.post("/api/conversations", async (request, reply) => {
    const body = z
      .object({
        requestId,
        title: z.string().min(1).max(200),
        modelId: z.string().uuid().optional(),
        model: z.string().min(1).max(200).optional(),
      })
      .strict()
      .parse(request.body);
    return reply
      .code(201)
      .send(
        await service.create(
          body.requestId,
          body.title,
          body.modelId,
          body.model,
        ),
      );
  });
  app.get("/api/conversations/:id", async (request) => {
    const { id } = identifier.parse(request.params),
      { cursor } = z
        .object({ cursor: z.string().max(3000).optional() })
        .parse(request.query);
    const parsed = cursor
      ? (z
          .record(z.string(), z.json())
          .parse(
            JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
          ) as Cursor)
      : undefined;
    return safe(await service.view(id, parsed));
  });
  app.put("/api/conversations/:id/model", async (request) => {
    const { id } = identifier.parse(request.params);
    const { modelId, model } = z
      .object({
        modelId: z.string().uuid(),
        model: z.string().min(1).max(200).optional(),
      })
      .strict()
      .parse(request.body);
    return safe(await service.selectModel(id, modelId, model));
  });
  app.post("/api/conversations/:id/messages", async (request, reply) => {
    const { id } = identifier.parse(request.params),
      body = z
        .object({
          requestId,
          text: z.string().min(1).max(64000),
          attachments: z.array(z.string().max(240)).max(20).default([]),
        })
        .strict()
        .parse(request.body);
    return reply
      .code(202)
      .send(
        await service.send(
          id,
          body.requestId,
          body.text,
          false,
          body.attachments,
        ),
      );
  });
  app.get("/api/conversations/:id/images", async (request, reply) => {
    const { id } = identifier.parse(request.params);
    const { entry, message, block } = z
      .object({
        entry: z.coerce.number().int().nonnegative(),
        message: z.coerce.number().int().min(0).max(1000),
        block: z.coerce.number().int().min(0).max(1000),
      })
      .strict()
      .parse(request.query);
    const image = await service.image(id, entry, message, block);
    return reply
      .header("Content-Type", image.mimeType)
      .header("Cache-Control", "private, no-store")
      .header("Content-Security-Policy", "sandbox; default-src 'none'")
      .header("X-Content-Type-Options", "nosniff")
      .send(image.bytes);
  });
  app.post("/api/conversations/:id/resume", async (request, reply) => {
    const { id } = identifier.parse(request.params),
      body = z.object({ requestId }).strict().parse(request.body);
    return reply
      .code(202)
      .send(await service.send(id, body.requestId, "", true));
  });
  app.post("/api/conversations/:id/stop", async (request) => {
    const { id } = identifier.parse(request.params);
    z.object({}).strict().parse(request.body);
    return service.stop(id);
  });
  app.get("/api/conversations/:id/files", async (request) => {
    const { id } = identifier.parse(request.params);
    return service.files(id);
  });
  app.get("/api/conversations/:id/download", async (request, reply) => {
    const { id } = identifier.parse(request.params),
      { path } = z
        .object({ path: z.string().max(240) })
        .strict()
        .parse(request.query);
    const bytes = await service.download(id, path),
      name = path.split("/").at(-1)!;
    return reply
      .header("Content-Type", "application/octet-stream")
      .header(
        "Content-Disposition",
        `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      .header("Content-Security-Policy", "sandbox; default-src 'none'")
      .send(bytes);
  });
  app.post(
    "/api/conversations/:id/uploads",
    { bodyLimit: 28 * 1024 * 1024 },
    async (request, reply) => {
      const { id } = identifier.parse(request.params),
        body = z
          .object({
            requestId,
            name: z
              .string()
              .min(1)
              .max(150)
              .refine((s) => !/[\\/\x00-\x1f]/.test(s)),
            data: z
              .string()
              .max(28 * 1024 * 1024)
              .regex(/^[A-Za-z0-9+/]*={0,2}$/),
          })
          .strict()
          .parse(request.body);
      return reply
        .code(201)
        .send(
          await service.upload(
            id,
            body.requestId,
            body.name,
            Buffer.from(body.data, "base64"),
          ),
        );
    },
  );
  app.get("/api/conversations/:id/events", async (request, reply) => {
    const { id } = identifier.parse(request.params),
      pi = await service.piConversation(id);
    if (streams >= 8) throw new AppError(429, "進捗接続の上限に達しました");
    const watch = await pi.watch(ctx, { min: 20, max: 40 }),
      token = request.cookies.agent_session!;
    streams++;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let closed = false,
      pending = false,
      sending = false;
    const close = () => {
      if (closed) return;
      closed = true;
      streams--;
      clearInterval(heartbeat);
      service.notifications.delete(changed);
      void watch.stop();
      reply.raw.end();
    };
    const send = async () => {
      if (closed) return;
      if (sending) {
        pending = true;
        return;
      }
      sending = true;
      try {
        do {
          pending = false;
          const session = sessions.get(token);
          if (!session || session.expires < Date.now()) {
            close();
            return;
          }
          const wire = `event: snapshot\ndata: ${JSON.stringify(safe(await service.view(id)))}\n\n`;
          if (reply.raw.writableLength > 512 * 1024) {
            close();
            return;
          }
          if (!reply.raw.write(wire))
            await new Promise<void>((resolve) => {
              reply.raw.once("drain", resolve);
              reply.raw.once("close", resolve);
            });
        } while (pending && !closed);
      } catch {
        close();
      } finally {
        sending = false;
      }
    };
    const changed = () => {
      void send();
    };
    const heartbeat = setInterval(() => {
      if (!closed) {
        if (!service.healthy()) close();
        else changed();
      }
    }, 10000);
    service.notifications.add(changed);
    request.raw.on("close", close);
    reply.raw.on("close", close);
    watch.start(async () => {
      await send();
    });
    await send();
  });
  for (const [path, name, type] of [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/style.css", "style.css", "text/css; charset=utf-8"],
    ["/bootstrap.css", "bootstrap.css", "text/css; charset=utf-8"],
  ]) {
    app.get(path!, async (_request, reply) =>
      reply.type(type!).send(await readFile(webRoot + name!)),
    );
  }
  return app;
}
