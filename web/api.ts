export type Message = {
  role: string;
  content: string;
  toolName: string | null;
  toolCallId: string | null;
  toolCalls: { id: string; name: string; argsText: string }[];
  isError: boolean;
  images?: { url: string }[];
  timestamp?: number;
};
export type Entry = { id: number; messages: Message[] };
export type Conversation = {
  id: string;
  title: string;
  status: string;
  detail: string;
  updatedAt: number;
  modelConfigId?: string;
  model?: string;
  parentId?: string;
  forkEntry?: number;
  pinned?: boolean;
  archived?: boolean;
};
export type View = {
  conversation: Conversation;
  transcript: Entry[];
  cursor: unknown;
  modelConfigured: boolean;
  pendingInputs: number;
  progress: {
    generating: boolean;
    partial: string;
    tools: { name: string; status: string; output: string }[];
  };
};
export type Files = {
  files: { path: string; size: number }[];
  truncated?: boolean;
};
export type MemoryNote = {
  id: string;
  text: string;
  source?: { sessionId: string; entryId?: number };
  createdAt: number;
  updatedAt: number;
  revision: number;
};
export type HistoryResults = {
  matches: {
    sessionId: string;
    title: string;
    entryId: number;
    role: string;
    text: string;
    timestamp: number;
  }[];
  cursor: string | null;
};
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(method === "GET" ? {} : { "X-CSRF-Token": csrf }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(response.status, value.error ?? "操作に失敗しました");
  return value as T;
}
// Persist request identity, never message text or attachment contents. A lost response reuses the same ID.
export async function requestId(key: string, body: unknown): Promise<string> {
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(body)),
      ),
    ),
  )
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const stored = sessionStorage.getItem(`agent-request-${key}`);
  if (stored) {
    const value = JSON.parse(stored);
    if (value.digest === digest) return value.id;
  }
  const id = crypto.randomUUID();
  sessionStorage.setItem(
    `agent-request-${key}`,
    JSON.stringify({ digest, id }),
  );
  return id;
}
export function forget(key: string) {
  sessionStorage.removeItem(`agent-request-${key}`);
}
export async function upload(id: string, file: File): Promise<string> {
  if (file.size > 20 * 1024 * 1024) throw new Error("添付は1件20 MiBまでです");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  const data = btoa(binary);
  const result = await api<{ path: string }>(
    `/api/conversations/${id}/uploads`,
    "POST",
    {
      requestId: await requestId(`upload-${id}-${file.name}`, {
        name: file.name,
        data,
      }),
      name: file.name,
      data,
    },
  );
  return result.path;
}
export const statuses: Record<string, string> = {
  idle: "応答終了",
  running: "実行中",
  stopping: "停止中",
  interrupted: "中断",
};
export function fileSize(size: number) {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KiB`;
}

export type ModelOptions = {
  catalog: string[];
  catalogs?: Record<string, string[]>;
  models: {
    id: string;
    name: string;
    model?: string;
    provider?: string;
    available: boolean;
    catalog?: string[];
    error?: string;
  }[];
  initialModel: string | null;
};

export function modelChoices(options: ModelOptions) {
  return options.models
    .filter((connection) => connection.available)
    .flatMap((connection) =>
      [
        ...new Set(
          connection.catalog ?? [
            ...(connection.model ? [connection.model] : []),
            ...(options.catalogs?.[connection.provider ?? "openai"] ??
              options.catalog),
          ],
        ),
      ].map((model) => ({
        id: JSON.stringify([connection.id, model]),
        name: model,
        group: connection.name,
        connectionId: connection.id,
        model,
        available: connection.available,
      })),
    );
}
