type Message = {
  role: string;
  content: string;
  toolName?: string;
  isError?: boolean;
};
type Entry = { id: number; messages: Message[] };
type Conversation = {
  id: string;
  title: string;
  status: string;
  detail: string;
  requests: number;
  updatedAt: number;
};
type View = {
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
const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let csrf = "",
  selected: string | null = null,
  events: EventSource | undefined,
  cursor: unknown = null,
  lastStatus = "",
  epoch = 0;
const entries = new Map<number, Entry>();
const status: Record<string, string> = {
  idle: "応答終了",
  running: "実行中",
  stopping: "停止中",
  interrupted: "中断",
};
function notice(error: unknown) {
  element("error").hidden = false;
  element("error").textContent =
    error instanceof Error ? error.message : "操作を完了できませんでした";
}
async function api<T>(
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
  if (response.status === 401) {
    showLogin();
    throw new Error("ログインしてください");
  }
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "操作に失敗しました");
  return value as T;
}
// Keep only request identity in sessionStorage so a lost response can be retried without duplicating input.
async function requestId(key: string, body: unknown): Promise<string> {
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
function forget(key: string) {
  sessionStorage.removeItem(`agent-request-${key}`);
}
function showLogin() {
  events?.close();
  element("login").hidden = false;
  element("app").hidden = true;
}
function clear() {
  epoch++;
  events?.close();
  selected = null;
  cursor = null;
  lastStatus = "";
  entries.clear();
  element("title").textContent = "新しい会話";
  element("state").textContent = "";
  element("state").hidden = true;
  element("detail").textContent = "";
  element("detail").hidden = true;
  element("transcript").replaceChildren();
  element("files").replaceChildren();
  element("files-section").hidden = true;
  element("actions").replaceChildren();
  element("live").textContent = "";
  element("earlier").hidden = true;
  element<HTMLTextAreaElement>("message").value = "";
  element<HTMLInputElement>("attachments").value = "";
  element("input-status").textContent = "";
}
async function list() {
  const value = await api<{ conversations: Conversation[] }>(
    "/api/conversations",
  );
  element("conversations").replaceChildren(
    ...value.conversations.map((conversation) => {
      const button = document.createElement("button");
      button.className = `list-group-item list-group-item-action text-break ${conversation.id === selected ? "active" : ""}`;
      button.textContent = conversation.title;
      if (conversation.id === selected)
        button.setAttribute("aria-current", "true");
      button.onclick = () => {
        void select(conversation.id).catch(notice);
      };
      return button;
    }),
  );
}
function drawTranscript() {
  element("transcript").replaceChildren(
    ...[...entries.values()]
      .sort((a, b) => a.id - b.id)
      .flatMap((entry) =>
        entry.messages
          .filter((message) => message.content.trim())
          .map((message) => {
            const wrapper = document.createElement(
              message.role === "toolResult" ? "details" : "article",
            );
            wrapper.className = "border-bottom pb-4 mb-4";
            if (wrapper instanceof HTMLDetailsElement) {
              const summary = document.createElement("summary");
              summary.textContent = `${message.toolName ?? "道具"}：${message.isError ? "失敗" : "実行結果"}`;
              summary.className = "small fg-2";
              wrapper.append(summary);
            } else {
              const role = document.createElement("span");
              role.className = "small fw-medium fg-2";
              role.textContent = message.role === "user" ? "あなた" : "Agent";
              wrapper.append(role);
            }
            const text = document.createElement("pre");
            text.className = "mt-3 mb-0";
            text.textContent = message.content;
            wrapper.append(text);
            return wrapper;
          }),
      ),
  );
}
function render(view: View, older = false) {
  if (view.conversation.id !== selected) return;
  element("title").textContent = view.conversation.title;
  element("state").textContent =
    status[view.conversation.status] ?? view.conversation.status;
  element("state").hidden = false;
  const detail =
    view.conversation.status === "interrupted" ? view.conversation.detail : "";
  element("detail").textContent = detail;
  element("detail").hidden = !detail;
  for (const entry of view.transcript) entries.set(entry.id, entry);
  if (!older && entries.size > 100)
    for (const id of [...entries.keys()]
      .sort((a, b) => a - b)
      .slice(0, entries.size - 100))
      entries.delete(id);
  drawTranscript();
  cursor = view.cursor;
  element("earlier").hidden = !cursor;
  element("input-status").textContent = view.pendingInputs
    ? `反映待ち：${view.pendingInputs}`
    : view.modelConfigured
      ? ""
      : "モデル未設定";
  element("live").textContent = [
    view.progress.partial,
    ...view.progress.tools
      .filter((tool) => tool.status !== "done")
      .map((tool) => `${tool.name}：${tool.status}\n${tool.output}`),
  ]
    .filter(Boolean)
    .join("\n");
  const actions = element("actions");
  actions.replaceChildren();
  if (
    view.conversation.status === "running" ||
    view.conversation.status === "interrupted"
  ) {
    const button = document.createElement("button");
    const running = view.conversation.status === "running";
    button.textContent = running ? "停止" : "再開";
    button.className = "btn-outline theme-secondary btn-sm";
    button.onclick = () => {
      button.disabled = true;
      const id = selected!;
      void api(
        `/api/conversations/${id}/${running ? "stop" : "resume"}`,
        "POST",
        running ? {} : { requestId: crypto.randomUUID() },
      )
        .then(() => refresh(id))
        .catch(notice)
        .finally(() => (button.disabled = false));
    };
    actions.append(button);
  }
  if (lastStatus !== view.conversation.status) {
    lastStatus = view.conversation.status;
    void list().catch(notice);
    void files().catch(() => {});
  }
}
async function refresh(id: string) {
  const view = await api<View>(`/api/conversations/${id}`);
  if (selected === id) render(view);
}
async function select(id: string) {
  clear();
  selected = id;
  const current = epoch;
  await refresh(id);
  if (current !== epoch) return;
  events = new EventSource(`/api/conversations/${id}/events`);
  events.addEventListener("snapshot", (event) => {
    if (current === epoch) render(JSON.parse((event as MessageEvent).data));
  });
  events.onopen = () => {
    if (current === epoch) element("connection").textContent = "接続中";
  };
  events.onerror = () => {
    if (current === epoch) element("connection").textContent = "再接続中";
  };
  await list();
  await files().catch(() => {});
}
async function files() {
  const id = selected;
  if (!id) {
    element("files").replaceChildren();
    return;
  }
  const value = await api<{
    files: { path: string; size: number }[];
    truncated?: boolean;
  }>(`/api/conversations/${id}/files`);
  if (selected !== id) return;
  const nodes: HTMLElement[] = value.files.map((file) => {
    const link = document.createElement("a");
    link.className = "list-group-item list-group-item-action text-break";
    link.textContent = `${file.path.slice(8)} · ${file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(1)} KiB`}`;
    link.href = `/api/conversations/${id}/download?path=${encodeURIComponent(file.path)}`;
    return link;
  });
  if (value.truncated) {
    const note = document.createElement("p");
    note.className = "small fg-2 mt-3";
    note.textContent = "表示上限に達しました";
    nodes.push(note);
  }
  element("files").replaceChildren(...nodes);
  element("files-section").hidden = nodes.length === 0;
}
element("login-form").onsubmit = (event) => {
  event.preventDefault();
  void (async () => {
    try {
      const password = element<HTMLInputElement>("password").value,
        response = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: crypto.randomUUID(), password }),
        }),
        value = await response.json();
      if (!response.ok) throw new Error(value.error);
      csrf = value.csrf;
      element<HTMLInputElement>("password").value = "";
      element("login").hidden = true;
      element("app").hidden = false;
      element("connection").textContent = "接続中";
      await list();
    } catch (error) {
      element("login-error").textContent =
        error instanceof Error ? error.message : "ログインできません";
    }
  })();
};
element("new-conversation").onclick = () => {
  clear();
  void list().catch(notice);
};
element("logout").onclick = () => {
  void api("/api/logout", "POST", { requestId: crypto.randomUUID() })
    .then(showLogin)
    .catch(notice);
};
element("refresh-files").onclick = () => {
  void files().catch(notice);
};
element("earlier").onclick = () => {
  if (!selected || !cursor) return;
  const id = selected;
  void api<View>(
    `/api/conversations/${id}?cursor=${encodeURIComponent(btoa(JSON.stringify(cursor)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""))}`,
  )
    .then((view) => {
      if (selected === id) render(view, true);
    })
    .catch(notice);
};
element("message-form").onsubmit = (event) => {
  event.preventDefault();
  const button = element<HTMLButtonElement>("send");
  button.disabled = true;
  element("error").hidden = true;
  void (async () => {
    const text = element<HTMLTextAreaElement>("message").value,
      attachments = Array.from(
        element<HTMLInputElement>("attachments").files ?? [],
      );
    let id = selected;
    if (!id) {
      const title = text.slice(0, 80);
      const created = await api<{ id: string }>("/api/conversations", "POST", {
        requestId: await requestId("create", { title }),
        title,
      });
      id = created.id;
      selected = id;
    }
    const paths: string[] = [];
    for (const file of attachments) {
      if (file.size > 20 * 1024 * 1024)
        throw new Error("添付は1件20 MiBまでです");
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 32768)
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      const data = btoa(binary),
        key = `upload-${id}-${file.name}`;
      const value = await api<{ path: string }>(
        `/api/conversations/${id}/uploads`,
        "POST",
        {
          requestId: await requestId(key, { name: file.name, data }),
          name: file.name,
          data,
        },
      );
      paths.push(value.path);
    }
    const content = paths.length
        ? `${text}\n\n添付：\n${paths.join("\n")}`
        : text,
      key = `message-${id}`;
    await api(`/api/conversations/${id}/messages`, "POST", {
      requestId: await requestId(key, { text: content }),
      text: content,
    });
    forget(key);
    forget("create");
    for (const file of attachments) forget(`upload-${id}-${file.name}`);
    await select(id);
    element<HTMLTextAreaElement>("message").value = "";
    element<HTMLInputElement>("attachments").value = "";
  })()
    .catch(notice)
    .finally(() => (button.disabled = false));
};
void api<{ csrf: string }>("/api/session")
  .then(async (session) => {
    csrf = session.csrf;
    element("login").hidden = true;
    element("app").hidden = false;
    element("connection").textContent = "接続中";
    await list();
  })
  .catch(showLogin);
