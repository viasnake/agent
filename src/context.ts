import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { Config, Paths } from "./config.js";
import {
  AgentError,
  type ContextCompaction,
  type ConversationContext,
  type Run,
} from "./types.js";
import { atomicWrite, canonical, privateDirectory, sha256 } from "./util.js";

const archiveIdPattern = /^[a-f0-9]{64}$/;
const excerptBytes = 1024;

export function emptyConversationContext(): ConversationContext {
  return {
    pins: [],
    decisions: [],
    openQuestions: [],
    constraints: [],
    instructions: [],
    sourceIds: [],
    imageIds: [],
    redactedImageIds: [],
    originalRunIds: [],
    workingState: {
      checks: [],
      hashes: {},
      artifacts: [],
      operations: [],
      history: [],
    },
    compactions: [],
  };
}

export function normalizeConversationContext(
  value: ConversationContext | undefined,
): ConversationContext {
  const fallback = emptyConversationContext();
  if (!value) return fallback;
  return {
    ...fallback,
    ...value,
    pins: value.pins ?? [],
    decisions: value.decisions ?? [],
    openQuestions: value.openQuestions ?? [],
    constraints: value.constraints ?? [],
    instructions: value.instructions ?? [],
    sourceIds: value.sourceIds ?? [],
    imageIds: value.imageIds ?? [],
    redactedImageIds: value.redactedImageIds ?? [],
    originalRunIds: value.originalRunIds ?? [],
    workingState: {
      ...fallback.workingState,
      ...(value.workingState ?? {}),
      checks: value.workingState?.checks ?? [],
      hashes: value.workingState?.hashes ?? {},
      artifacts: value.workingState?.artifacts ?? [],
      operations: value.workingState?.operations ?? [],
      history: (value.workingState?.history ?? []).map((entry) => ({
        ...entry,
        operations: entry.operations ?? [],
        results: (entry.results ?? []).map((result) => ({
          ...result,
          author: "model" as const,
          trusted: false as const,
        })),
      })),
    },
    compactions: value.compactions ?? [],
  };
}

function archiveRoot(paths: Paths, run: Run): string {
  if (!/^[a-f0-9-]{36}$/i.test(run.id))
    throw new AgentError("CONTEXT_ARCHIVE", "Invalid run archive owner");
  if (run.conversationId && !/^[a-f0-9-]{36}$/i.test(run.conversationId))
    throw new AgentError(
      "CONTEXT_ARCHIVE",
      "Invalid conversation archive owner",
    );
  return run.conversationId
    ? join(paths.home, "conversations", run.conversationId, "archives")
    : join(paths.runs, run.id, "context-archives");
}

function archivePath(paths: Paths, run: Run, archiveId: string): string {
  if (!archiveIdPattern.test(archiveId))
    throw new AgentError("CONTEXT_ARCHIVE", "Invalid context archive ID");
  return join(archiveRoot(paths, run), `${archiveId}.json`);
}

export function countContextImages(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce((sum, item) => sum + countContextImages(item), 0);
  if (!value || typeof value !== "object") return 0;
  const record = value as Record<string, unknown>;
  const own = record.type === "image" ? 1 : 0;
  return (
    own +
    Object.values(record).reduce<number>(
      (sum, item) => sum + countContextImages(item),
      0,
    )
  );
}

export function estimateContextBytes(value: unknown): number {
  const imageCount = countContextImages(value);
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).type === "image" &&
      typeof (item as Record<string, unknown>).data === "string"
    )
      return {
        ...(item as Record<string, unknown>),
        data: "[image data omitted]",
      };
    return item;
  });
  return Buffer.byteLength(serialized ?? "") + imageCount * 8192 * 3;
}

export function contextBudget(
  config: Config,
  contextWindow: number,
  maxOutputTokens: number,
): { usableBytes: number; triggerBytes: number; targetBytes: number } {
  const usableBytes = Math.min(
    config.limits.maxInputBytes,
    Math.max(0, (contextWindow - maxOutputTokens) * 3),
  );
  return {
    usableBytes,
    triggerBytes: Math.ceil(usableBytes * 0.8),
    targetBytes: Math.floor(usableBytes * 0.6),
  };
}

function roleOf(message: Record<string, unknown>): string {
  return typeof message.role === "string" ? message.role : "";
}

function isToolResult(message: Record<string, unknown>): boolean {
  return roleOf(message) === "tool" || roleOf(message) === "toolResult";
}

function isErrorResult(message: Record<string, unknown>): boolean {
  return message.isError === true || message.error === true;
}

function archiveMarker(archiveId: string): string {
  return `[Older tool result archived as ${archiveId}; use read_context to retrieve it.]`;
}

function shorten(text: string, archiveId: string): string {
  const marker = archiveMarker(archiveId);
  const room = Math.max(0, excerptBytes - Buffer.byteLength(marker));
  if (Buffer.byteLength(text) <= room) return text;
  const first = Math.floor(room / 2);
  const last = room - first;
  const bytes = Buffer.from(text);
  const head = bytes.subarray(0, first).toString("utf8");
  const tail = bytes.subarray(bytes.length - last).toString("utf8");
  return `${head}\n…\n${tail}\n${marker}`;
}

function compactMessage(
  message: Record<string, unknown>,
  archiveId: string,
  level: "excerpt" | "marker",
) {
  const compactText = (text: string) => {
    const marker = archiveMarker(archiveId);
    if (level === "marker")
      return Buffer.byteLength(text) <= Buffer.byteLength(marker)
        ? text
        : marker;
    return shorten(text, archiveId);
  };
  const content = message.content;
  if (typeof content === "string")
    return { ...message, content: compactText(content) };
  if (!Array.isArray(content)) return message;
  return {
    ...message,
    content: content.map((part) => {
      if (
        part &&
        typeof part === "object" &&
        (part as Record<string, unknown>).type === "text" &&
        typeof (part as Record<string, unknown>).text === "string"
      )
        return {
          ...(part as Record<string, unknown>),
          text: compactText((part as Record<string, unknown>).text as string),
        };
      return part;
    }),
  };
}

function compactCandidate(
  context: unknown,
  archiveId: string,
  targetBytes: number,
): { value: unknown; compacted: boolean; protectedValue: unknown } {
  if (!context || typeof context !== "object")
    return { value: context, compacted: false, protectedValue: context };
  const value = structuredClone(context);
  const messages =
    value &&
    typeof value === "object" &&
    Array.isArray((value as Record<string, unknown>).messages)
      ? ((value as Record<string, unknown>).messages as unknown[])
      : undefined;
  if (!messages) return { value, compacted: false, protectedValue: context };
  const lastTool = messages.reduce(
    (last, item, index) =>
      item &&
      typeof item === "object" &&
      isToolResult(item as Record<string, unknown>)
        ? index
        : last,
    -1,
  );
  const eligible = messages.map(
    (item, index) =>
      !!item &&
      typeof item === "object" &&
      isToolResult(item as Record<string, unknown>) &&
      index !== lastTool &&
      !isErrorResult(item as Record<string, unknown>),
  );
  let compacted = false;
  for (const level of ["excerpt", "marker"] as const) {
    for (let index = 0; index < messages.length; index++) {
      if (!eligible[index]) continue;
      const current = (value as Record<string, unknown>).messages as unknown[];
      const item = current[index];
      if (!item || typeof item !== "object") continue;
      const replacement = compactMessage(
        item as Record<string, unknown>,
        archiveId,
        level,
      );
      if (canonical(replacement) === canonical(item)) continue;
      current[index] = replacement;
      compacted = true;
      if (estimateContextBytes(value) <= targetBytes) break;
    }
    if (estimateContextBytes(value) <= targetBytes) break;
  }
  const protectedValue = structuredClone(context);
  if (Array.isArray((protectedValue as Record<string, unknown>).messages))
    (protectedValue as Record<string, unknown>).messages = messages.filter(
      (item, index) =>
        !(
          item &&
          typeof item === "object" &&
          isToolResult(item as Record<string, unknown>) &&
          index !== lastTool &&
          !isErrorResult(item as Record<string, unknown>)
        ),
    );
  return { value, compacted, protectedValue };
}

function protectedProjection(context: unknown): unknown {
  if (!context || typeof context !== "object") return context;
  const value = structuredClone(context);
  const messages =
    value &&
    typeof value === "object" &&
    Array.isArray((value as Record<string, unknown>).messages)
      ? ((value as Record<string, unknown>).messages as unknown[])
      : undefined;
  if (!messages) return value;
  const lastTool = messages.reduce(
    (last, item, index) =>
      item &&
      typeof item === "object" &&
      isToolResult(item as Record<string, unknown>)
        ? index
        : last,
    -1,
  );
  (value as Record<string, unknown>).messages = messages.filter(
    (item, index) =>
      !(
        item &&
        typeof item === "object" &&
        isToolResult(item as Record<string, unknown>) &&
        index !== lastTool &&
        !isErrorResult(item as Record<string, unknown>)
      ),
  );
  return value;
}

export async function archiveContext(
  paths: Paths,
  run: Run,
  context: unknown,
): Promise<{ archiveId: string; bytes: number }> {
  const serialized = JSON.stringify(context);
  if (serialized === undefined)
    throw new AgentError(
      "CONTEXT_ARCHIVE",
      "Provider context is not serializable",
    );
  const archiveId = sha256(serialized);
  const root = archiveRoot(paths, run);
  await privateDirectory(paths.home);
  if (run.conversationId) {
    await privateDirectory(join(paths.home, "conversations"));
    await privateDirectory(
      join(paths.home, "conversations", run.conversationId),
    );
  }
  await privateDirectory(root);
  const destination = archivePath(paths, run, archiveId);
  try {
    const existing = await lstat(destination);
    if (
      existing.isFile() &&
      !existing.isSymbolicLink() &&
      !(existing.mode & 0o077) &&
      (!process.getuid || existing.uid === process.getuid())
    ) {
      await readContextArchive(paths, run, archiveId, 1);
      return { archiveId, bytes: Buffer.byteLength(serialized) };
    }
    throw new AgentError(
      "UNSAFE_STORAGE",
      "Context archive must be a private regular file",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWrite(destination, serialized);
  return { archiveId, bytes: Buffer.byteLength(serialized) };
}

export async function compactContext(
  paths: Paths,
  run: Run,
  context: unknown,
  options: {
    config: Config;
    contextWindow: number;
    maxOutputTokens: number;
    trigger: "automatic" | "manual";
    force?: boolean;
    signal?: AbortSignal;
  },
): Promise<{ context: unknown; record: ContextCompaction } | undefined> {
  options.signal?.throwIfAborted();
  const beforeBytes = estimateContextBytes(context);
  const budget = contextBudget(
    options.config,
    options.contextWindow,
    options.maxOutputTokens,
  );
  if (!options.force && beforeBytes < budget.triggerBytes) return undefined;
  const serialized = JSON.stringify(context);
  if (serialized === undefined)
    throw new AgentError(
      "CONTEXT_ARCHIVE",
      "Provider context is not serializable",
    );
  const candidate = compactCandidate(
    context,
    sha256(serialized),
    budget.targetBytes,
  );
  if (!candidate.compacted && beforeBytes <= budget.usableBytes) {
    if (!options.force) return undefined;
    const archive = await archiveContext(paths, run, context);
    options.signal?.throwIfAborted();
    return {
      context,
      record: {
        id: sha256(
          canonical({
            archiveId: archive.archiveId,
            beforeBytes,
            afterBytes: beforeBytes,
            trigger: options.trigger,
          }),
        ),
        archiveId: archive.archiveId,
        at: Date.now(),
        beforeBytes,
        afterBytes: beforeBytes,
        trigger: options.trigger,
        heuristic: "bytes/3+images*8192",
      },
    };
  }
  if (!candidate.compacted)
    throw new AgentError(
      "CONTEXT_LIMIT",
      "Protected context exceeds the provider context budget; remove old tool-independent content or start a new conversation",
    );
  const afterBytes = estimateContextBytes(candidate.value);
  if (
    canonical(protectedProjection(context)) !==
      canonical(protectedProjection(candidate.value)) ||
    afterBytes > budget.usableBytes
  )
    throw new AgentError(
      "CONTEXT_LIMIT",
      "Context remains above the provider context budget after compacting older tool results; no protected content was truncated",
    );
  const archive = await archiveContext(paths, run, context);
  options.signal?.throwIfAborted();
  return {
    context: candidate.value,
    record: {
      id: sha256(
        canonical({
          archiveId: archive.archiveId,
          beforeBytes,
          afterBytes,
          trigger: options.trigger,
        }),
      ),
      archiveId: archive.archiveId,
      at: Date.now(),
      beforeBytes,
      afterBytes,
      trigger: options.trigger,
      heuristic: "bytes/3+images*8192",
    },
  };
}

export async function readContextArchive(
  paths: Paths,
  run: Run,
  archiveId: string,
  maxBytes = 32_000,
  start = 0,
): Promise<string> {
  if (run.contextState?.redactedImageIds?.length)
    throw new AgentError(
      "CONTEXT_ARCHIVE_REDACTED",
      "Archived provider context is unavailable after an image was removed or masked",
    );
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 32_000
  )
    throw new AgentError("CONTEXT_ARCHIVE", "Context archive range is invalid");
  const path = archivePath(paths, run, archiveId);
  const directories = run.conversationId
    ? [
        paths.home,
        join(paths.home, "conversations"),
        join(paths.home, "conversations", run.conversationId),
        archiveRoot(paths, run),
      ]
    : [
        paths.home,
        paths.runs,
        join(paths.runs, run.id),
        archiveRoot(paths, run),
      ];
  for (const directory of directories) {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new AgentError(
        "UNSAFE_STORAGE",
        "Context archive directory must be private",
      );
  }
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new AgentError(
        "UNSAFE_STORAGE",
        "Context archive must be a private regular file",
      );
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    for (let position = 0; position < info.size;) {
      const { bytesRead } = await file.read(
        chunk,
        0,
        Math.min(chunk.length, info.size - position),
        position,
      );
      if (!bytesRead)
        throw new AgentError("CONTEXT_ARCHIVE", "Context archive is truncated");
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (hash.digest("hex") !== archiveId)
      throw new AgentError("CONTEXT_ARCHIVE", "Context archive hash mismatch");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await file.read(buffer, 0, maxBytes, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}
