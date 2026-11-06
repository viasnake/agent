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
const revision = z.number().int().positive();
const identifier = z.object({ id: z.string().uuid() });
const createSchema = z
  .object({
    requestId,
    title: z.string().min(1).max(200),
    objective: z.string().min(1).max(64000),
    kind: z.enum(["code", "research"]),
    acceptance: z.array(z.string().min(1).max(1000)).min(1).max(20),
    project: z.string().max(100).default(""),
    parentId: z.string().uuid().optional(),
    repoUrl: z.string().url().max(2000).optional(),
    attachmentIds: z.array(z.string().uuid()).max(20).default([]),
    externalAllowed: z.boolean().default(false),
  })
  .strict();
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
  app.get("/api/jobs", async (request) => {
    const { offset, limit } = z
      .object({
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(50).default(30),
      })
      .parse(request.query);
    const state = await service.snapshot();
    return safe({
      jobs: [...state.jobs]
        .reverse()
        .slice(offset, offset + limit)
        .map((job) => ({
          id: job.id,
          title: job.title,
          status: job.status,
          waitReason: job.waitReason,
          detail: job.detail,
          revision: job.revision,
          updatedAt: job.updatedAt,
        })),
      nextOffset: offset + limit < state.jobs.length ? offset + limit : null,
    });
  });
  app.post("/api/jobs", async (request, reply) => {
    const result = await service.create(createSchema.parse(request.body));
    return reply.code(202).send(result);
  });
  app.get("/api/jobs/:id", async (request) => {
    const { id } = identifier.parse(request.params);
    const { cursor } = z
      .object({ cursor: z.string().max(3000).optional() })
      .parse(request.query);
    const parsedCursor = cursor
      ? (z
          .record(z.string(), z.json())
          .parse(
            JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
          ) as Cursor)
      : undefined;
    const view = await service.view(id, parsedCursor);
    return safe(view);
  });
  app.post("/api/jobs/:id/inputs", async (request, reply) => {
    const { id } = identifier.parse(request.params),
      body = z
        .object({ requestId, text: z.string().min(1).max(16000) })
        .strict()
        .parse(request.body);
    return reply
      .code(202)
      .send(await service.input(id, body.requestId, body.text));
  });
  app.post("/api/jobs/:id/actions", async (request, reply) => {
    const { id } = identifier.parse(request.params),
      body = z
        .object({
          requestId,
          revision,
          action: z.enum(["pause", "resume", "cancel"]),
          extensionSeconds: z.number().int().min(60).max(86400).optional(),
          additionalModelRequests: z.number().int().min(1).max(60).optional(),
          useConfiguredModel: z.boolean().optional(),
        })
        .strict()
        .parse(request.body);
    return reply
      .code(202)
      .send(
        await service.action(
          id,
          body.requestId,
          body.revision,
          body.action,
          body.extensionSeconds,
          body.additionalModelRequests,
          body.useConfiguredModel,
        ),
      );
  });
  app.post("/api/jobs/:id/approvals", async (request, reply) => {
    const { id } = identifier.parse(request.params),
      body = z
        .object({
          requestId,
          revision,
          operationId: z.string().uuid(),
          approved: z.boolean(),
        })
        .strict()
        .parse(request.body);
    return reply
      .code(202)
      .send(
        await service.approve(
          id,
          body.requestId,
          body.revision,
          body.operationId,
          body.approved,
        ),
      );
  });
  app.post("/api/jobs/:id/reconciliations", async (request, reply) => {
    const { id } = identifier.parse(request.params),
      body = z
        .object({
          requestId,
          revision,
          operationId: z.string().max(100),
          resolution: z.enum([
            "check_github",
            "completed",
            "not_executed",
            "acknowledge_recovery",
          ]),
          evidence: z.string().min(8).max(8000),
        })
        .strict()
        .parse(request.body);
    return reply
      .code(202)
      .send(
        await service.reconcile(
          id,
          body.requestId,
          body.revision,
          body.operationId,
          body.resolution,
          body.evidence,
        ),
      );
  });
  app.post(
    "/api/uploads",
    { bodyLimit: 28 * 1024 * 1024 },
    async (request, reply) => {
      const body = z
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
            body.requestId,
            body.name,
            Buffer.from(body.data, "base64"),
          ),
        );
    },
  );
  app.get("/api/artifacts/:id/download", async (request, reply) => {
    const { id } = identifier.parse(request.params),
      state = await service.snapshot();
    const artifact = state.jobs
      .flatMap((job) => job.artifacts)
      .find((item) => item.id === id);
    if (!artifact) throw new AppError(404, "成果物がありません");
    const bytes = await service.artifacts.read(artifact);
    return reply
      .header("Content-Type", artifact.mediaType)
      .header(
        "Content-Disposition",
        `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
      )
      .header("Content-Security-Policy", "sandbox; default-src 'none'")
      .send(bytes);
  });
  app.get("/api/settings", async () => {
    const state = await service.snapshot();
    return safe({
      ...state.settings,
      modelConfigured: service.modelState() === "ready",
      modelState: service.modelState(),
      model: service.config.model
        ? {
            provider: service.config.model.provider,
            id: service.config.model.id,
          }
        : null,
      repositories: service.config.github?.repositories ?? [],
      recoveryHold: state.recoveryHold,
      limits: service.config.limits,
    });
  });
  app.patch("/api/settings", async (request) => {
    const body = z
      .object({
        requestId,
        revision,
        commonInstructions: z.string().max(16000),
        projectNotes: z
          .record(z.string().max(100), z.string().max(16000))
          .refine((value) => Object.keys(value).length <= 50),
      })
      .strict()
      .parse(request.body);
    return service.settings(
      body.requestId,
      body.revision,
      body.commonInstructions,
      body.projectNotes,
    );
  });
  app.get("/api/jobs/:id/events", async (request, reply) => {
    const { id } = identifier.parse(request.params),
      job = await service.job(id);
    if (streams >= 8) throw new AppError(429, "進捗接続の上限に達しました");
    streams++;
    const sessionToken = request.cookies.agent_session!,
      conversation = (await service.harness.conversation(
        job.conversationId,
        ctx,
      ))!,
      watch = await conversation.watch(ctx, { min: 20, max: 40 });
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
    const send = async () => {
      if (closed || sending) {
        pending = true;
        return;
      }
      if (
        !sessions.has(sessionToken) ||
        sessions.get(sessionToken)!.expires < Date.now()
      ) {
        reply.raw.end();
        return;
      }
      sending = true;
      try {
        const view = safe(await service.view(id));
        const packet = `event: snapshot\ndata: ${JSON.stringify(view)}\n\n`;
        if (!reply.raw.write(packet))
          await new Promise<void>((resolve) => {
            reply.raw.once("drain", resolve);
            reply.raw.once("close", resolve);
          });
      } catch {
        reply.raw.end();
      } finally {
        sending = false;
      }
    };
    const update = () => {
      pending = true;
    };
    service.notifications.add(update);
    watch.start(async () => {
      pending = true;
    });
    const flush = setInterval(() => {
      if (pending) {
        pending = false;
        void send();
      }
    }, 250);
    const heartbeat = setInterval(() => {
      if (!closed && !sending) {
        if (!sessions.has(sessionToken)) reply.raw.end();
        else reply.raw.write(": heartbeat\n\n");
      }
    }, 15000);
    reply.raw.on("close", () => {
      closed = true;
      clearInterval(flush);
      clearInterval(heartbeat);
      service.notifications.delete(update);
      streams--;
      void watch.stop();
    });
    await send();
  });
  for (const [route, file, type] of [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/style.css", "style.css", "text/css; charset=utf-8"],
  ]) {
    app.get(route!, async (_request, reply) =>
      reply.type(type!).send(await readFile(joinPath(webRoot, file!))),
    );
  }
  return app;
}
function joinPath(root: string, name: string): string {
  return fileURLToPath(
    new URL(name, root.endsWith("/") ? `file://${root}` : `file://${root}/`),
  );
}
