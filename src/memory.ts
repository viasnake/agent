import { defineDoc } from "@earendil-works/pi-durable";
import type { Cursor, EntryId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { z } from "zod";
import type { AgentService } from "./service.js";
import { ConversationsDoc } from "./state.js";
import { AppError, hash } from "./security.js";

export const memoryId = z.union([
  z.string().uuid(),
  z.string().regex(/^[a-f0-9]{64}$/),
]);
export const memorySource = z
  .object({
    sessionId: z.string().uuid(),
    entryId: z.number().int().positive().optional(),
  })
  .strict();
export const memoryInput = z
  .object({
    requestId: memoryId,
    text: z.string().trim().min(1).max(1000),
    source: memorySource.optional(),
  })
  .strict();
export const historyInput = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    timezone: z.string().max(100).default("UTC"),
    cursor: z.string().max(4000).optional(),
  })
  .strict()
  .refine(
    (value) => value.query || value.date,
    "検索語か日付を指定してください",
  );
export type Memory = {
  id: string;
  text: string;
  source?: z.infer<typeof memorySource>;
  sourceSessionIds?: string[];
  createdAt: number;
  updatedAt: number;
  revision: number;
  requestHash: string;
  deleted?: boolean;
};
export const MemoriesDoc = defineDoc<{ notes: Memory[] }>({
  kind: "agent.memories",
  version: 1,
  scope: "session",
  initial: () => ({ notes: [] }),
  checkpointWhen: () => true,
});
const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase();
const sourceSessions = (note: Memory) => [
  ...(note.source ? [note.source.sessionId] : []),
  ...(note.sourceSessionIds ?? []),
];
const visibleNote = (note: Memory, sessions: Set<string>) =>
  !note.deleted && sourceSessions(note).every((id) => sessions.has(id));
export const memoryRevision = z
  .object({
    id: memoryId,
    revision: z.number().int().positive(),
  })
  .strict();
export const memoryUpdate = memoryRevision.extend({
  text: z.string().trim().min(1).max(1000),
  merge: z.array(memoryRevision).min(1).max(31).optional(),
});
type MemoryWriteOptions = {
  revision?: number;
  source?: z.infer<typeof memorySource>;
  merge?: z.infer<typeof memoryRevision>[];
};

export function localDate(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp);
  return ["year", "month", "day"]
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join("-");
}

export class SessionMemory {
  constructor(private service: AgentService) {}

  async read(source: z.infer<typeof memorySource>) {
    const { sessionId, entryId } = memorySource.parse(source);
    const session = await this.service.conversation(sessionId);
    const pi = await this.service.harness.conversation(session.piId, ctx);
    if (!pi) throw new AppError(503, "保存されたセッションがありません");
    const page = await pi.entries(
      entryId
        ? { minEntryId: entryId as EntryId, maxEntryId: entryId as EntryId }
        : { order: "descending" },
      entryId ? 1 : 20,
      undefined,
      ctx,
    );
    let remaining = 12000;
    const messages = page.items.flatMap((entry) =>
      (entry.model ?? []).flatMap((message) => {
        if (remaining <= 0) return [];
        const text = this.service.redact(
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
        );
        const excerpt = text.slice(0, remaining);
        remaining -= excerpt.length;
        return [
          {
            entryId: entry.id,
            role: message.role,
            timestamp: message.timestamp,
            text: excerpt,
            ...(message.role === "toolResult"
              ? { isError: message.isError }
              : {}),
          },
        ];
      }),
    );
    if (entryId && !page.items.length)
      throw new AppError(404, "出典のメッセージがありません");
    await this.service.conversation(sessionId);
    return {
      sessionId,
      title: this.service.redact(session.title),
      messages,
      truncated: !!page.next || remaining === 0,
    };
  }

  async list() {
    const notes =
      (await this.service.harness.snapshot(MemoriesDoc, ctx))?.notes ?? [];
    const sessions = await this.service.list();
    const visible = new Set(sessions.map((session) => session.id));
    return notes
      .filter((note) => visibleNote(note, visible))
      .map(({ requestHash: _, sourceSessionIds: _sources, ...note }) => ({
        ...note,
        text: this.service.redact(note.text),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async save(input: z.infer<typeof memoryInput>) {
    const value = memoryInput.parse(input);
    value.text = this.service.redact(value.text);
    await this.service.list();
    if (value.source?.entryId) {
      const session = await this.service.conversation(value.source.sessionId);
      const pi = await this.service.harness.conversation(session.piId, ctx);
      const page = await pi!.entries(
        {
          minEntryId: value.source.entryId as EntryId,
          maxEntryId: value.source.entryId as EntryId,
        },
        1,
        undefined,
        ctx,
      );
      if (
        !page.items.some((entry) =>
          entry.model?.some(
            (message) =>
              message.role === "user" || message.role === "assistant",
          ),
        )
      )
        throw new AppError(404, "出典のメッセージがありません");
    }
    await this.service.harness.commit(async (tx) => {
      const sessions = (await tx.doc(ConversationsDoc)).conversations;
      if (
        value.source &&
        !sessions.some(
          (session) =>
            session.id === value.source!.sessionId && !session.deletedAt,
        )
      )
        throw new AppError(404, "出典のセッションがありません");
      const state = await tx.doc(MemoriesDoc);
      const digest = hash(
        JSON.stringify({ text: value.text, source: value.source }),
      );
      const existing = state.notes.find((note) => note.id === value.requestId);
      if (existing) {
        if (existing.deleted) throw new AppError(410, "記憶は削除されています");
        if (existing.requestHash !== digest)
          throw new AppError(409, "保存内容が一致しません");
        return;
      }
      const visible = new Set(
        sessions
          .filter((session) => !session.deletedAt)
          .map((session) => session.id),
      );
      const active = state.notes.filter((note) => visibleNote(note, visible));
      if (
        state.notes.length >= 2048 ||
        active.length >= 32 ||
        active.reduce((size, note) => size + note.text.length, 0) +
          value.text.length >
          8000
      )
        throw new AppError(
          413,
          "記憶の上限に達しました。不要な記憶を削除してください",
        );
      const now = Date.now();
      state.notes.push({
        id: value.requestId,
        text: value.text,
        ...(value.source ? { source: value.source } : {}),
        createdAt: now,
        updatedAt: now,
        revision: 1,
        requestHash: digest,
      });
    }, ctx);
    return { id: value.requestId };
  }

  async change(
    id: string,
    change?: { text: string; revision: number },
    options: MemoryWriteOptions = {},
  ) {
    memoryId.parse(id);
    if (change) {
      change = z
        .object({
          text: z.string().trim().min(1).max(1000),
          revision: z.number().int().positive(),
        })
        .strict()
        .parse(change);
      change.text = this.service.redact(change.text);
    }
    const source = options.source
      ? memorySource.parse(options.source)
      : undefined;
    const merge = z
      .array(memoryRevision)
      .max(31)
      .parse(options.merge ?? []);
    if (
      (!change && merge.length) ||
      merge.some((item) => item.id === id) ||
      new Set(merge.map((item) => item.id)).size !== merge.length
    )
      throw new AppError(400, "統合する記憶が不正です");
    const expected =
      change?.revision ??
      (options.revision === undefined
        ? undefined
        : z.number().int().positive().parse(options.revision));
    await this.service.list();
    await this.service.harness.commit(async (tx) => {
      const sessions = (await tx.doc(ConversationsDoc)).conversations;
      const visible = new Set(
        sessions
          .filter((session) => !session.deletedAt)
          .map((session) => session.id),
      );
      const notes = (await tx.doc(MemoriesDoc)).notes;
      const note = notes.find((item) => item.id === id);
      if (
        !note ||
        sourceSessions(note).some((sessionId) => !visible.has(sessionId)) ||
        (source && !visible.has(source.sessionId))
      )
        throw new AppError(404, "記憶がありません");
      const unchanged =
        !!change && note.text === change.text && !source && !merge.length;
      if (expected !== undefined && note.revision !== expected && !unchanged)
        throw new AppError(
          409,
          "記憶が更新されています。読み込み直してください",
        );
      if (!change) {
        note.deleted = true;
        note.text = "";
      } else {
        if (note.deleted) throw new AppError(410, "記憶は削除されています");
        if (note.text === change.text && !source && !merge.length) return;
        // Validate the entire consolidation before writing any note, including source lineage.
        const merged = merge.map((item) => {
          const candidate = notes.find((other) => other.id === item.id);
          if (!candidate || !visibleNote(candidate, visible))
            throw new AppError(404, "統合する記憶がありません");
          if (candidate.revision !== item.revision)
            throw new AppError(
              409,
              "記憶が更新されています。読み込み直してください",
            );
          return candidate;
        });
        const total = notes
          .filter(
            (item) =>
              visibleNote(item, visible) &&
              !merged.some((other) => other.id === item.id),
          )
          .reduce((size, item) => size + item.text.length, 0);
        if (total - note.text.length + change.text.length > 8000)
          throw new AppError(413, "記憶の上限を超えています");
        note.text = change.text;
        note.sourceSessionIds = [
          ...new Set([
            ...sourceSessions(note),
            ...merged.flatMap(sourceSessions),
            ...(source ? [source.sessionId] : []),
          ]),
        ];
        if (source) note.source = source;
        for (const candidate of merged) {
          candidate.deleted = true;
          candidate.text = "";
          candidate.revision++;
          candidate.updatedAt = Date.now();
        }
      }
      note.revision++;
      note.updatedAt = Date.now();
    }, ctx);
    return { id };
  }

  async search(input: z.input<typeof historyInput>) {
    const value = historyInput.parse(input);
    try {
      localDate(Date.now(), value.timezone);
      if (
        value.date &&
        new Date(`${value.date}T00:00:00Z`).toISOString().slice(0, 10) !==
          value.date
      )
        throw new Error();
    } catch {
      throw new AppError(400, "日付またはタイムゾーンが不正です");
    }
    const filter = hash(
      JSON.stringify([value.query, value.date, value.timezone]),
    );
    const cursorSchema = z
      .object({
        sessionId: z.string().uuid(),
        entry: z.record(z.string(), z.json()).optional(),
        filter: z.literal(filter),
      })
      .strict();
    let start: z.infer<typeof cursorSchema> | undefined;
    if (value.cursor) {
      try {
        start = cursorSchema.parse(
          JSON.parse(Buffer.from(value.cursor, "base64url").toString()),
        );
      } catch {
        throw new AppError(400, "検索位置が不正です");
      }
    }
    const sessions = (await this.service.list())
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((session) => !start || session.id >= start.sessionId);
    const matches: {
      sessionId: string;
      title: string;
      entryId: number;
      role: string;
      text: string;
      timestamp: number;
    }[] = [];
    const needle = value.query ? normalize(value.query) : "";
    let next: string | null = null;
    // A bounded scan is sufficient for the initial local implementation; no extra index or model call.
    for (
      let budget = 0, index = 0;
      index < sessions.length && budget < 8 && matches.length < 20;
      budget++
    ) {
      const session = sessions[index]!;
      const pi = await this.service.harness.conversation(session.piId, ctx);
      if (!pi) throw new AppError(503, "保存されたセッションがありません");
      const page = await pi.entries(
        { order: "descending" },
        20,
        start?.sessionId === session.id
          ? (start.entry as Cursor | undefined)
          : undefined,
        ctx,
      );
      for (const entry of page.items) {
        // Forked ancestors are already represented by their original session.
        if (entry.conversationId !== session.piId) continue;
        for (const message of entry.model ?? []) {
          if (message.role !== "user" && message.role !== "assistant") continue;
          if (
            value.date &&
            (!Number.isFinite(message.timestamp) ||
              localDate(message.timestamp, value.timezone) !== value.date)
          )
            continue;
          const text = this.service.redact(
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n"),
          );
          if (!text || (needle && !normalize(text).includes(needle))) continue;
          matches.push({
            sessionId: session.id,
            title: this.service.redact(session.title),
            entryId: entry.id,
            role: message.role,
            text: text.slice(0, 320),
            timestamp: message.timestamp,
          });
          break;
        }
      }
      if (page.next)
        start = { sessionId: session.id, entry: page.next, filter };
      else {
        index++;
        start = sessions[index]
          ? { sessionId: sessions[index]!.id, filter }
          : undefined;
      }
      next = start
        ? Buffer.from(JSON.stringify(start)).toString("base64url")
        : null;
    }
    // Check visibility again after asynchronous reads, including concurrent deletions.
    const visible = new Set(
      (await this.service.list()).map((session) => session.id),
    );
    return {
      matches: matches.filter((match) => visible.has(match.sessionId)),
      cursor: next,
      timezone: value.timezone,
    };
  }
}
