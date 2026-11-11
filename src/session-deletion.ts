import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { JsonObject } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Cursor,
  DocumentCreate,
  DocumentId,
  DocumentRecord,
  EntryId,
  Page,
  Seq,
  Storage,
  StorageWrite,
  StoredDocument,
  TaskId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { z } from "zod";
import type { Runner } from "./execution/protocol.js";
import type { State } from "./state.js";
import type { Memory } from "./memory.js";
import { hash } from "./security.js";

const markerName = "session-deletion.json";
const stagingName = "conversations-delete.sqlite";
export const conversationDatabase = "conversations-v1.sqlite";

async function syncDirectory(path: string) {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function requestDeletion(control: string, id: string) {
  z.string().uuid().parse(id);
  const temporary = join(control, `${markerName}.tmp`);
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify({ id }));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, join(control, markerName));
  await syncDirectory(control);
}

async function* pages<T>(scan: (cursor?: Cursor) => Promise<Page<T, Cursor>>) {
  let cursor: Cursor | undefined;
  do {
    const page = await scan(cursor);
    yield* page.items;
    cursor = page.next;
  } while (cursor);
}

async function write(storage: Storage, writes: StorageWrite[]) {
  if (!writes.length) return;
  const result = await storage.commit([writes], () => {}, ctx);
  if (result.stored !== 1)
    throw result.refused ?? new Error("Storage copy failed");
}

async function document(storage: Storage, kind: string) {
  const record = await storage.findDocument(
    { kind, scope: { kind: "session" } },
    "current",
    ctx,
  );
  return record && (await storage.document(record.id, "current", ctx));
}

/** Rebuild through the public Storage contract; never mutate Pi's private tables. */
export async function copyWithoutSession(
  source: Storage,
  destination: Storage,
  id: string,
) {
  const stateDoc = await document(source, "agent.conversations");
  if (!stateDoc) throw new Error("Unknown conversation storage");
  const state = structuredClone(stateDoc.value) as unknown as State;
  if (state.schemaVersion !== 1)
    throw new Error("Incompatible conversation storage");
  const target = state.conversations.find((item) => item.id === id);
  if (!target) throw new Error("Deletion target is missing");
  target.deletedAt ??= Date.now();
  target.purgedAt ??= Date.now();
  const purged = new Set(
    state.conversations.filter((item) => item.purgedAt).map((item) => item.id),
  );
  const retained = new Set(
    state.conversations
      .filter((item) => !item.purgedAt)
      .map((item) => item.piId),
  );
  state.conversations = state.conversations.map((item) =>
    item.purgedAt
      ? {
          id: item.id,
          piId: item.piId,
          deletedAt: item.deletedAt,
          purgedAt: item.purgedAt,
          title: "",
          status: "idle",
          detail: "",
          updatedAt: 0,
          requests: 0,
          deadlineAt: null,
          workspaceCreated: false,
        }
      : item,
  );

  const records = new Map<
    ConversationId,
    Awaited<ReturnType<Storage["conversation"]>>
  >();
  for await (const record of pages((cursor) =>
    source.scanConversations({}, 256, cursor, ctx),
  ))
    records.set(record.id, record);
  // Include SDK-owned child scopes of surviving conversations.
  for (let changed = true; changed; ) {
    changed = false;
    for (const record of records.values())
      if (
        record?.owner &&
        retained.has(record.owner.conversationId) &&
        !retained.has(record.id)
      ) {
        retained.add(record.id);
        changed = true;
      }
  }
  const ancestors = new Set(retained);
  for (const conversationId of ancestors) {
    const record = records.get(conversationId);
    if (!record) throw new Error("Missing conversation ancestry");
    if (record.parent) ancestors.add(record.parent.conversationId);
  }
  for (const conversationId of ancestors) {
    const record = records.get(conversationId)!;
    await write(destination, [
      {
        type: "conversation",
        value: retained.has(conversationId)
          ? record
          : {
              id: record.id,
              ...(record.parent ? { parent: record.parent } : {}),
            },
      },
    ]);
  }

  const tasks = new Set<TaskId>();
  for await (const task of pages((cursor) =>
    source.scanTasks({}, 1, cursor, ctx),
  )) {
    if (!retained.has(task.conversationId)) continue;
    tasks.add(task.id);
    await write(destination, [{ type: "task", value: task }]);
  }
  for await (const submission of pages((cursor) =>
    source.scanSubmissions({}, 256, cursor, ctx),
  ))
    if (retained.has(submission.conversationId))
      await write(destination, [{ type: "submission", value: submission }]);

  // Retain only history actually visible in surviving sessions, including fork cutoffs.
  // IDs and entry ownership stay stable for citations and deduplicated date searches.
  const entries = new Map<
    EntryId,
    { seq: Seq; conversationId: ConversationId }
  >();
  for (const conversationId of retained)
    for await (const entry of pages((cursor) =>
      source.scanEntries(
        { conversationId, order: "ascending" },
        1,
        cursor,
        ctx,
      ),
    )) {
      if (entries.has(entry.id)) continue;
      const stored = await source.entry(entry.id, ctx);
      if (!stored) throw new Error("Missing history entry");
      entries.set(entry.id, {
        seq: stored.commitSeq,
        conversationId: entry.conversationId,
      });
    }

  const copied = new Map<DocumentId, string>();
  const currentByScope = new Map<string, Set<DocumentId>>();
  const copyDocument = (stored: StoredDocument): StorageWrite[] => {
    const content = {
      kind: "base" as const,
      version: stored.version,
      value: stored.value,
    };
    const value = hash(content);
    if (copied.get(stored.record.id) === value) return [];
    const exists = copied.has(stored.record.id);
    copied.set(stored.record.id, value);
    const { createdAt: _, retiredAt: _retired, ...record } = stored.record;
    return [
      exists
        ? { type: "document.change", id: record.id, content }
        : {
            type: "document.create",
            record: record as DocumentCreate,
            content,
          },
    ];
  };
  const copyScope = async (
    scope: DocumentRecord["scope"],
    at: Seq | "current",
    rewindableOnly = false,
  ) => {
    const writes: StorageWrite[] = [];
    const scopeKey = JSON.stringify([scope, rewindableOnly]);
    const present = new Set<DocumentId>();
    for await (const record of pages((cursor) =>
      source.scanDocuments({ scope, at }, 128, cursor, ctx),
    )) {
      if (rewindableOnly && record.history !== "rewindable") continue;
      if (record.kind === "agent.storage-watermark") continue;
      const snapshot = await source.document(record.id, at, ctx);
      const stored = snapshot && { ...snapshot };
      if (!stored) throw new Error("Missing document snapshot");
      present.add(record.id);
      if (record.kind === "agent.conversations")
        stored.value = state as unknown as JsonObject;
      if (record.kind === "agent.memories") {
        const notes = (stored.value as unknown as { notes: Memory[] }).notes;
        stored.value = {
          // Keep content-free receipts so replaying an earlier save cannot restore
          // a consolidated note whose other source session still exists.
          notes: notes.map((note) =>
            [note.source?.sessionId, ...(note.sourceSessionIds ?? [])].some(
              (sourceId) => sourceId && purged.has(sourceId),
            )
              ? { ...note, text: "", deleted: true }
              : note,
          ),
        } as unknown as JsonObject;
      }
      writes.push(...copyDocument(stored));
    }
    for (const previous of currentByScope.get(scopeKey) ?? [])
      if (!present.has(previous))
        writes.unshift({ type: "document.retire", id: previous });
    currentByScope.set(scopeKey, present);
    return writes;
  };
  for (const [entryId, { seq, conversationId }] of [...entries].sort(
    (a, b) => a[1].seq - b[1].seq || a[0] - b[0],
  )) {
    const stored = await source.entry(entryId, ctx);
    if (!stored) throw new Error("Missing history entry");
    const { byTaskId, ...entry } = stored.entry;
    await write(destination, [
      ...(await copyScope({ kind: "conversation", conversationId }, seq, true)),
      {
        type: "entry",
        value: byTaskId && tasks.has(byTaskId) ? stored.entry : entry,
      },
    ]);
  }
  for (const conversationId of retained) {
    await write(
      destination,
      await copyScope(
        { kind: "conversation", conversationId },
        "current",
        true,
      ),
    );
    await write(
      destination,
      await copyScope({ kind: "conversation", conversationId }, "current"),
    );
  }
  for (const taskId of tasks)
    await write(
      destination,
      await copyScope({ kind: "task", taskId }, "current"),
    );
  await write(destination, await copyScope({ kind: "session" }, "current"));
  // Never reuse a purged entry/task ID after reopening the replacement database.
  await write(destination, [
    {
      type: "document.create",
      record: {
        id: await source.mintId<DocumentId>(),
        kind: "agent.storage-watermark",
        scope: { kind: "session" },
      },
      content: { kind: "base", version: 1, value: {} },
    },
  ]);
}

/** A durable intent survives every interruption until both the workspace and old DB are gone. */
export async function finishDeletion(
  control: string,
  runner: Runner,
): Promise<void> {
  const marker = join(control, markerName);
  const pending = await readFile(marker, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (pending === undefined) return;
  const { id } = z
    .object({ id: z.string().uuid() })
    .strict()
    .parse(JSON.parse(pending));
  const path = join(control, conversationDatabase);
  await stat(path); // Never create an empty replacement for a missing source.
  const staging = join(control, stagingName);
  const source = await openNodeSqliteStorage(path);
  try {
    const state = (await document(source, "agent.conversations"))
      ?.value as unknown as State | undefined;
    if (
      state?.schemaVersion !== 1 ||
      !state.conversations.some((item) => item.id === id)
    )
      throw new Error("Unknown deletion target or conversation storage");
    await runner.ready();
    const cleaned = await runner.call(id, "cleanup", {});
    if (!cleaned.cleanup)
      throw new Error("Deletion requires confirmed worker cleanup");
    await runner.call(id, "delete_workspace", {});
    for (const suffix of ["", "-wal", "-shm"])
      await rm(`${staging}${suffix}`, { force: true });
    const stagingFile = await open(staging, "wx", 0o600);
    await stagingFile.close();
    const destination = await openNodeSqliteStorage(staging);
    try {
      await copyWithoutSession(source, destination, id);
    } finally {
      await destination.close(ctx);
    }
  } finally {
    await source.close(ctx);
  }
  const file = await open(staging, "r+");
  try {
    await file.chmod(0o600);
    await file.sync();
  } finally {
    await file.close();
  }
  // Both SDK connections are closed before removing journals or replacing the inode.
  for (const suffix of ["-wal", "-shm"])
    await rm(`${path}${suffix}`, { force: true });
  await rename(staging, path);
  await syncDirectory(dirname(path));
  await rm(marker);
  await syncDirectory(control);
}
