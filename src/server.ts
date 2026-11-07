import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AgentService } from "./service.js";
import { AppError } from "./security.js";
import type { Cursor } from "@earendil-works/pi-durable";

const requestId = z.string().uuid();
const identifier = z.object({ id: z.string().uuid() });
const digest = (value: string) => createHash("sha256").update(value).digest();
type Session = { csrf: string; expires: number };
export async function createServer(
  service: AgentService,
  password: string,
  webRoot = fileURLToPath(new URL("../web/", import.meta.url)),
): Promise<FastifyInstance> {
  if (password.length < 32)
    throw new Error(
      "A random UI credential of at least 32 characters is required",
    );
  const app = Fastify({
    logger: false,
    bodyLimit: 128 * 1024,
    requestTimeout: 30000,
    routerOptions: { maxParamLength: 100 },
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 180, timeWindow: "1 minute" });
  const sessions = new Map<string, Session>(),
    loginReceipts = new Map<string, { hash: Buffer; token: string }>();
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
    if (!request.url.startsWith("/api/") || request.url === "/api/login")
      return;
    const session = sessions.get(request.cookies.agent_session ?? "");
    if (!session || session.expires < Date.now())
      throw new AppError(401, "ログインしてください");
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.headers["x-csrf-token"] !== session.csrf
    )
      throw new AppError(403, "画面を更新して操作をやり直してください");
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      void reply
        .code(400)
        .send({ error: "入力の形式・上限を確認してください" });
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
  app.post(
    "/api/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = z
        .object({ requestId, password: z.string().max(1000) })
        .strict()
        .parse(request.body);
      for (const [token, session] of sessions)
        if (session.expires < Date.now()) sessions.delete(token);
      if (!timingSafeEqual(digest(body.password), digest(password)))
        throw new AppError(401, "認証情報が一致しません");
      const previous = loginReceipts.get(body.requestId);
      if (previous && !timingSafeEqual(previous.hash, digest(body.password)))
        throw new AppError(409, "requestId の内容が一致しません");
      const token = previous?.token ?? randomBytes(32).toString("hex");
      if (!sessions.has(token)) {
        if (sessions.size >= 24) {
          const oldest = sessions.keys().next().value;
          if (oldest) sessions.delete(oldest);
        }
        sessions.set(token, {
          csrf: randomBytes(32).toString("hex"),
          expires: Date.now() + 12 * 3600 * 1000,
        });
      }
      if (loginReceipts.size > 100) loginReceipts.clear();
      loginReceipts.set(body.requestId, { hash: digest(body.password), token });
      reply.setCookie("agent_session", token, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: request.headers.origin?.startsWith("https://") === true,
        maxAge: 12 * 3600,
      });
      return { csrf: sessions.get(token)!.csrf };
    },
  );
  app.get("/api/session", async (request) => ({
    csrf: sessions.get(request.cookies.agent_session!)!.csrf,
  }));
  app.post("/api/logout", async (request, reply) => {
    z.object({ requestId }).strict().parse(request.body);
    sessions.delete(request.cookies.agent_session!);
    reply.clearCookie("agent_session", { path: "/" });
    return { ok: true };
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
      .object({ requestId, title: z.string().min(1).max(200) })
      .strict()
      .parse(request.body);
    return reply
      .code(201)
      .send(await service.create(body.requestId, body.title));
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
  app.post("/api/conversations/:id/messages", async (request, reply) => {
    const { id } = identifier.parse(request.params),
      body = z
        .object({ requestId, text: z.string().min(1).max(64000) })
        .strict()
        .parse(request.body);
    return reply
      .code(202)
      .send(await service.send(id, body.requestId, body.text));
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
  ]) {
    app.get(path!, async (_request, reply) =>
      reply.type(type!).send(await readFile(webRoot + name!)),
    );
  }
  return app;
}
