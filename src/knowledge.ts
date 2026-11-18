import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { AgentService } from "./service.js";
import { ConversationsDoc } from "./state.js";
import { AppError, hash } from "./security.js";

export type KnowledgeNote = {
  id: string;
  title: string;
  body: string;
  revision: number;
  sources: { sessionId: string; entryId?: number }[];
  updatedAt: number;
  expired: boolean;
};
export type KnowledgeState = {
  notes: KnowledgeNote[];
  receipts?: Record<string, { id: string; hash: string }>;
};
export const KnowledgeDoc = defineDoc<KnowledgeState>({
  kind: "agent.knowledge",
  version: 1,
  scope: "session",
  initial: () => ({ notes: [] }),
  checkpointWhen: () => true,
});
export const knowledgeEdit = z
  .object({
    id: z.string().uuid().optional(),
    revision: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(160),
    body: z.string().max(32000),
    expired: z.boolean().default(false),
  })
  .strict();

// Markdown is canonical in Storage. No independently editable filesystem copy.
export class Knowledge {
  constructor(private service: AgentService) {}
  async list(query = "", offset = 0) {
    const notes = await this.visible();
    const needle = query.normalize("NFKC").toLocaleLowerCase();
    const found = notes.filter(
      (n) =>
        !needle ||
        `${n.title}\n${n.body}`
          .normalize("NFKC")
          .toLocaleLowerCase()
          .includes(needle),
    );
    return {
      notes: found
        .slice(offset, offset + 20)
        .map(({ body, ...n }) => ({ ...n, excerpt: body.slice(0, 240) })),
      next: offset + 20 < found.length ? offset + 20 : null,
    };
  }
  private async visible() {
    const state = await this.service.harness.snapshot(ConversationsDoc, ctx);
    const ids = new Set(
      state?.conversations.filter((c) => !c.deletedAt).map((c) => c.id),
    );
    return this.service.sanitize(
      (await this.service.harness.snapshot(KnowledgeDoc, ctx))?.notes.filter(
        (n) => n.sources.every((s) => ids.has(s.sessionId)),
      ) ?? [],
    );
  }
  async read(id: string) {
    const note = (await this.visible()).find((n) => n.id === id);
    if (!note) throw new AppError(404, "記憶がありません");
    return note;
  }
  async update(
    input: z.infer<typeof knowledgeEdit>,
    sources: KnowledgeNote["sources"] = [],
    requestId?: string,
    authorize?: () => Promise<unknown>,
  ) {
    const change = this.service.sanitize(knowledgeEdit.parse(input));
    return this.service.exclusive(async () => {
      this.service.assertHealthy();
      await authorize?.();
      const result = await this.service.harness.commit(async (tx) => {
        const state = await tx.doc(ConversationsDoc);
        for (const source of sources)
          if (
            !state.conversations.some(
              (c) => c.id === source.sessionId && !c.deletedAt,
            )
          )
            throw new AppError(410, "出典は削除されています");
        const doc = await tx.doc(KnowledgeDoc);
        const digest = hash(change);
        const receipt = requestId && doc.receipts?.[requestId];
        if (receipt) {
          if (receipt.hash !== digest)
            throw new AppError(409, "保存内容が一致しません");
          const saved = doc.notes.find((n) => n.id === receipt.id);
          if (!saved) throw new AppError(410, "記憶は削除されています");
          return JSON.parse(JSON.stringify(saved)) as typeof saved;
        }
        const previous = change.id && doc.notes.find((n) => n.id === change.id);
        if (change.id && !previous) throw new AppError(404, "記憶がありません");
        if ((previous ? previous.revision : 0) !== change.revision)
          throw new AppError(409, "記憶が更新されています。読み直してください");
        if (!previous && doc.notes.length >= 128)
          throw new AppError(413, "記憶の保存上限に達しました");
        const note: KnowledgeNote = {
          ...change,
          id: previous ? previous.id : randomUUID(),
          revision: change.revision + 1,
          sources: [...(previous ? previous.sources : []), ...sources].filter(
            (s, index, all) =>
              all.findIndex(
                (v) => v.sessionId === s.sessionId && v.entryId === s.entryId,
              ) === index,
          ),
          updatedAt: Date.now(),
        };
        if (note.sources.length > 128)
          throw new AppError(413, "出典の上限に達しました");
        if (previous)
          doc.notes[doc.notes.findIndex((n) => n.id === note.id)] = note;
        else doc.notes.push(note);
        if (
          doc.notes.reduce((total, n) => total + n.body.length, 0) > 1_000_000
        )
          throw new AppError(413, "記憶の本文が保存上限に達しました");
        if (requestId) {
          doc.receipts ??= {};
          if (Object.keys(doc.receipts).length >= 4096)
            throw new AppError(413, "保存要求の上限に達しました");
          doc.receipts[requestId] = { id: note.id, hash: digest };
        }
        return JSON.parse(JSON.stringify(note)) as typeof note;
      }, ctx);
      this.service.notify();
      return this.service.sanitize(result);
    });
  }
}
