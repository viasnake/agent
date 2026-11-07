import { NotificationProvider, useNotify } from "./notifications.js";
import { ModelPicker } from "./model-picker.js";
import type { ReactNode } from "react";
import { Settings } from "./settings.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import type { AppendMessage } from "@assistant-ui/react";
import {
  api,
  modelChoices,
  ApiError,
  setCsrf,
  fileSize,
  forget,
  requestId,
  statuses,
  upload,
} from "./api.js";
import type { Conversation, Entry, Files, View, ModelOptions } from "./api.js";
import {
  AssistantMessage,
  ConversationId,
  threadMessages,
  toolLabel,
  UserMessage,
} from "./messages.js";
import { Icon } from "./icons.js";

type ThreadProps = {
  view: View | null;
  entries: Entry[];
  cursor: unknown;
  modelPicker: ReactNode;
  loading: boolean;
  sending: boolean;
  attachments: File[];
  setAttachments: (files: File[]) => void;
  onSend: (message: AppendMessage) => Promise<void>;
  onEarlier: () => Promise<void>;
};
function SendButton({ sending }: { sending: boolean }) {
  const aui = useAui();
  const canSend = useAuiState((state) => state.composer.canSend);
  // Pi already accepts steering in its durable inbox; do not introduce a browser queue.
  return (
    <button
      id="send"
      type="button"
      className="btn-solid theme-primary btn-sm ms-auto"
      disabled={!canSend || sending}
      onClick={() => aui.composer().send()}
    >
      <Icon name="send" />
      {sending ? "送信中…" : "送る"}
    </button>
  );
}
function Chat({
  view,
  entries,
  cursor,
  sending,
  attachments,
  setAttachments,
  onSend,
  onEarlier,
  modelPicker,
  loading,
}: ThreadProps) {
  const messages = useMemo(
    () => threadMessages(entries, view),
    [entries, view],
  );
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message) => message,
    isRunning: view?.conversation.status === "running",
    isSendDisabled: sending || view?.conversation.status === "stopping",
    onNew: async (message) => {
      try {
        await onSend(message);
      } catch {
        // A transport failure may follow durable admission. Restore only for an explicit
        // retry with the saved request ID; never classify it as an unexecuted operation.
        if (!runtime.thread.composer.getState().text)
          runtime.thread.composer.setText(
            message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
          );
      }
    },
    hasEarlier: !!cursor,
    onLoadEarlier: onEarlier,
  });
  const input = useRef<HTMLInputElement>(null);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ConversationId.Provider value={view?.conversation.id ?? null}>
        <ThreadPrimitive.Root
          className={`chat-thread ${!messages.length && !loading ? "chat-empty" : ""}`}
        >
          <ThreadPrimitive.Viewport
            className="thread-viewport"
            id="transcript"
            aria-label="会話の履歴"
          >
            <div className="thread-content">
              {loading && (
                <div className="history-loading" role="status">
                  会話を読み込み中…
                </div>
              )}
              {!messages.length && !loading && (
                <div className="empty-thread">
                  <span className="empty-icon">
                    <Icon name="agent" />
                  </span>
                  <h2>何を始めますか？</h2>
                </div>
              )}
              {!!cursor && (
                <ThreadPrimitive.LoadEarlier
                  id="earlier"
                  className="btn-text theme-secondary btn-sm mb-5"
                >
                  以前の記録
                </ThreadPrimitive.LoadEarlier>
              )}
              <ThreadPrimitive.Messages>
                {({ message }) =>
                  message.role === "user" ? (
                    <UserMessage />
                  ) : (
                    <AssistantMessage />
                  )
                }
              </ThreadPrimitive.Messages>
              {view?.conversation.status === "running" && (
                <div id="live" role="status" className="live-status">
                  <span className="running-dot" />
                  {view.progress.tools.some((tool) => tool.status !== "done")
                    ? `${view.progress.tools
                        .filter((tool) => tool.status !== "done")
                        .map((tool) => toolLabel(tool.name))
                        .join("・")}…`
                    : "応答中"}
                </div>
              )}
            </div>
          </ThreadPrimitive.Viewport>
          <div className="composer-dock">
            <ThreadPrimitive.ScrollToBottom
              className="scroll-bottom btn-outline theme-secondary btn-sm"
              aria-label="最新のメッセージへ"
            >
              <Icon name="down" />
            </ThreadPrimitive.ScrollToBottom>
            <ComposerPrimitive.Root
              id="message-form"
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                runtime.thread.composer.send();
              }}
            >
              <label htmlFor="message" className="visually-hidden">
                メッセージ
              </label>
              <ComposerPrimitive.Input
                id="message"
                placeholder="メッセージを入力…"
                className="composer-input"
                rows={2}
                maxRows={8}
                maxLength={64000}
                disabled={sending}
                submitMode="ctrlEnter"
                onKeyDown={(event) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key === "Enter" &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    runtime.thread.composer.send();
                  }
                }}
                addAttachmentOnPaste={false}
                autoFocus
              />
              {attachments.length > 0 && (
                <div className="attachment-chips">
                  {attachments.map((file, index) => (
                    <span key={index} className="attachment-chip">
                      <Icon name="file" />
                      <span>{file.name}</span>
                      <button
                        type="button"
                        className="btn-text theme-secondary btn-sm"
                        aria-label={`${file.name} を取り除く`}
                        disabled={sending}
                        onClick={() =>
                          setAttachments(
                            attachments.filter((_, i) => i !== index),
                          )
                        }
                      >
                        <Icon name="close" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="composer-toolbar">
                <input
                  id="attachments"
                  type="file"
                  multiple
                  ref={input}
                  hidden
                  onChange={(event) => {
                    setAttachments([
                      ...attachments,
                      ...Array.from(event.target.files ?? []),
                    ]);
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="btn-text theme-secondary btn-sm"
                  disabled={sending}
                  aria-label="添付"
                  title="添付"
                  onClick={() => input.current?.click()}
                >
                  <Icon name="attach" />
                </button>
                {modelPicker}
                <span id="input-status" className="small fg-2">
                  {view?.pendingInputs
                    ? `反映待ち：${view.pendingInputs}`
                    : view && !view.modelConfigured
                      ? "モデル未設定"
                      : ""}
                </span>
                <SendButton sending={sending} />
              </div>
            </ComposerPrimitive.Root>
            <div className="composer-shortcut">Ctrl / ⌘ + Enter</div>
          </div>
        </ThreadPrimitive.Root>
      </ConversationId.Provider>
    </AssistantRuntimeProvider>
  );
}

function App() {
  const notify = useNotify();
  const [modelOptions, setModelOptions] = useState<ModelOptions>({
    catalog: [],
    models: [],
    initialModel: null,
  });
  const choices = useMemo(() => modelChoices(modelOptions), [modelOptions]);
  const [draftModel, setDraftModel] = useState("");
  const [changingModel, setChangingModel] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(
    new URLSearchParams(location.search).has("settings"),
  );
  const [ready, setReady] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  const [view, setView] = useState<View | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<unknown>(null);
  const [files, setFiles] = useState<Files>({ files: [] });
  const [attachments, setAttachments] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState(false);
  const [threadKey, setThreadKey] = useState(0);
  const [sidebar, setSidebar] = useState(false);
  const [connection, setConnection] = useState("接続中");
  const [error, setError] = useState("");
  const notice = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) setReady(false);
      const message =
        error instanceof Error ? error.message : "操作を完了できませんでした";
      setError(message);
      notify(message, true);
    },
    [notify],
  );
  const list = useCallback(async () => {
    const result = await api<{ conversations: Conversation[] }>(
      "/api/conversations",
    );
    setConversations(result.conversations);
  }, []);
  const refreshFiles = useCallback(async (id: string) => {
    const result = await api<Files>(`/api/conversations/${id}/files`);
    if (selectedRef.current === id) setFiles(result);
  }, []);
  const merge = useCallback((next: View) => {
    if (selectedRef.current !== next.conversation.id) return;
    setView(next);
    setEntries((previous) => [
      ...new Map(
        [...previous, ...next.transcript].map((entry) => [entry.id, entry]),
      ).values(),
    ]);
  }, []);
  function select(id: string | null) {
    setSettingsOpen(false);
    selectedRef.current = id;
    setSelected(id);
    setView(null);
    setEntries([]);
    setCursor(null);
    setFiles({ files: [] });
    setAttachments([]);
    setError("");
    setThreadKey((key) => key + 1);
    setSidebar(false);
  }
  const connect = useCallback(async () => {
    setError("");
    try {
      const session = await api<{ csrf: string }>("/api/session");
      setCsrf(session.csrf);
      setReady(true);
    } catch (error) {
      notice(error);
    }
  }, [notice]);
  useEffect(() => {
    void connect();
  }, [connect]);
  useEffect(() => {
    if (!ready || settingsOpen) return;
    let active = true;
    void api<ModelOptions>("/api/model-options")
      .then((options) => {
        if (!active) return;
        setModelOptions(options);
        const available = modelChoices(options);
        setDraftModel((old) =>
          available.some((m) => m.id === old)
            ? old
            : (available.find((m) => m.connectionId === options.initialModel)
                ?.id ??
              available[0]?.id ??
              ""),
        );
      })
      .catch(notice);
    return () => {
      active = false;
    };
  }, [ready, settingsOpen, notice]);
  async function changeModel(choiceId: string) {
    const choice = choices.find((m) => m.id === choiceId);
    if (!choice) return;
    if (!selectedRef.current) {
      setDraftModel(choiceId);
      return;
    }
    setChangingModel(true);
    try {
      merge(
        await api<View>(
          `/api/conversations/${selectedRef.current}/model`,
          "PUT",
          { modelId: choice.connectionId, model: choice.model },
        ),
      );
    } catch (error) {
      notice(error);
    } finally {
      setChangingModel(false);
    }
  }
  useEffect(() => {
    if (!ready) return;
    void list().catch(notice);
  }, [ready, list, notice]);
  useEffect(() => {
    if (!ready || !selected) return;
    let active = true;
    const id = selected;
    const events = new EventSource(`/api/conversations/${id}/events`);
    void api<View>(`/api/conversations/${id}`)
      .then((next) => {
        if (active) {
          merge(next);
          setCursor(next.cursor);
        }
      })
      .catch(notice);
    events.addEventListener("snapshot", (event) => {
      if (active) merge(JSON.parse((event as MessageEvent).data));
    });
    events.onopen = () => {
      if (active) setConnection("接続中");
    };
    events.onerror = () => {
      if (active) setConnection("再接続中");
    };
    return () => {
      active = false;
      events.close();
    };
  }, [ready, selected, merge, notice]);
  const currentStatus = view?.conversation.status;
  useEffect(() => {
    if (!ready || !selected) return;
    void list().catch(notice);
    void refreshFiles(selected).catch(notice);
  }, [ready, selected, currentStatus, list, refreshFiles, notice]);
  useEffect(() => {
    if (!sidebar) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebar(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [sidebar]);
  async function send(message: AppendMessage) {
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const attached = [...attachments];
    setSending(true);
    setError("");
    try {
      let id = selectedRef.current;
      if (!id) {
        const title = text.slice(0, 80);
        const choice = choices.find((m) => m.id === draftModel);
        const selection = choice
          ? { modelId: choice.connectionId, model: choice.model }
          : {};
        const created = await api<{ id: string }>(
          "/api/conversations",
          "POST",
          {
            requestId: await requestId("create", {
              title,
              ...selection,
            }),
            title,
            ...selection,
          },
        );
        id = created.id;
        // Keep the composer mounted so a rejected/lost response can restore its draft.
        selectedRef.current = id;
        setSelected(id);
      }
      const paths: string[] = [];
      for (const file of attached) paths.push(await upload(id, file));
      const content = paths.length
        ? `${text}\n\n添付：\n${paths.join("\n")}`
        : text;
      const key = `message-${id}`;
      await api(`/api/conversations/${id}/messages`, "POST", {
        requestId: await requestId(key, { text: content }),
        text: content,
      });
      forget(key);
      forget("create");
      for (const file of attached) forget(`upload-${id}-${file.name}`);
      setAttachments([]);
      await api<View>(`/api/conversations/${id}`).then(merge).catch(notice);
      await list().catch(notice);
    } catch (error) {
      notice(error);
      throw error;
    } finally {
      setSending(false);
    }
  }
  async function earlier() {
    if (!selected || !cursor) return;
    try {
      const encoded = btoa(JSON.stringify(cursor))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const next = await api<View>(
        `/api/conversations/${selected}?cursor=${encodeURIComponent(encoded)}`,
      );
      if (selectedRef.current !== selected) return;
      // Older pages extend the transcript without replacing the current execution state.
      setEntries((previous) => [
        ...new Map(
          [...next.transcript, ...previous].map((entry) => [entry.id, entry]),
        ).values(),
      ]);
      setCursor(next.cursor);
    } catch (error) {
      notice(error);
    }
  }
  async function action() {
    if (!selected || !view) return;
    const id = selected;
    setActing(true);
    try {
      const resume = view.conversation.status === "interrupted";
      await api(
        `/api/conversations/${id}/${resume ? "resume" : "stop"}`,
        "POST",
        resume ? { requestId: await requestId(`resume-${id}`, {}) } : {},
      );
      forget(`resume-${id}`);
      merge(await api<View>(`/api/conversations/${id}`));
    } catch (error) {
      notice(error);
    } finally {
      setActing(false);
    }
  }
  if (!ready)
    return (
      <div className="connection-page">
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <button
              className="btn-solid theme-primary"
              onClick={() => void connect()}
            >
              再接続
            </button>
          </div>
        ) : (
          <span role="status">接続中…</span>
        )}
      </div>
    );
  return (
    <div id="app" className="app-shell">
      {sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="会話一覧を閉じる"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside
        id="sidebar"
        className={`sidebar ${sidebar ? "sidebar-open" : ""}`}
      >
        <button
          className="sidebar-close mobile-only btn-text theme-secondary btn-sm"
          aria-label="会話一覧を閉じる"
          onClick={() => setSidebar(false)}
        >
          <Icon name="close" />
        </button>
        <button
          id="new-conversation"
          className="btn-outline theme-secondary new-conversation"
          disabled={sending}
          onClick={() => select(null)}
        >
          <Icon name="plus" />
          新しい会話
        </button>
        <h2 className="sidebar-label">会話</h2>
        <nav id="conversations" aria-label="会話一覧">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              disabled={sending}
              aria-current={conversation.id === selected ? "true" : undefined}
              className={`conversation-item ${conversation.id === selected ? "selected" : ""}`}
              onClick={() => select(conversation.id)}
            >
              <span className={`status-dot ${conversation.status}`} />
              <span>{conversation.title}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button
            className="btn-text theme-secondary btn-sm"
            onClick={() => {
              setSettingsOpen(true);
              setSidebar(false);
            }}
          >
            設定
          </button>
          <span id="connection" className="small fg-2" role="status">
            <span
              className={`status-dot ${connection === "接続中" ? "connected" : ""}`}
            />
            {connection}
          </span>
        </div>
      </aside>
      {settingsOpen ? (
        <Settings
          onClose={() => {
            setSettingsOpen(false);
            history.replaceState(null, "", location.pathname);
          }}
        />
      ) : (
        <main className="workspace">
          <header className="conversation-header">
            <button
              className="mobile-only btn-text theme-secondary btn-sm"
              aria-label="会話一覧を開く"
              aria-expanded={sidebar}
              aria-controls="sidebar"
              onClick={() => setSidebar(!sidebar)}
            >
              <Icon name="menu" />
            </button>
            <h1 id="title">{view?.conversation.title ?? "新しい会話"}</h1>
            {view && (
              <span
                id="state"
                className={`badge badge-subtle ${currentStatus === "running" ? "theme-primary" : "theme-secondary"}`}
              >
                {statuses[currentStatus!] ?? currentStatus}
              </span>
            )}
            <div id="actions" className="ms-auto">
              {(currentStatus === "running" ||
                currentStatus === "interrupted") && (
                <button
                  className="btn-outline theme-secondary btn-sm"
                  disabled={acting}
                  onClick={() => void action()}
                >
                  {currentStatus === "running" ? "停止" : "再開"}
                </button>
              )}
            </div>
          </header>
          {currentStatus === "interrupted" && (
            <p
              id="detail"
              className="workspace-notice small fg-2"
              role="status"
            >
              {view?.conversation.detail}
            </p>
          )}
          {files.files.length > 0 && (
            <section
              id="files-section"
              className="output-files"
              aria-label="生成ファイル"
            >
              <div className="output-label">
                <Icon name="file" />
                <span>ファイル</span>
                <button
                  id="refresh-files"
                  className="btn-text theme-secondary btn-sm"
                  onClick={() =>
                    selected && void refreshFiles(selected).catch(notice)
                  }
                >
                  更新
                </button>
              </div>
              <div id="files">
                {files.files.map((file) => (
                  <a
                    key={file.path}
                    className="output-file"
                    href={`/api/conversations/${selected}/download?path=${encodeURIComponent(file.path)}`}
                  >
                    <Icon name="down" />
                    <span>{file.path.slice(8)}</span>
                    <small>{fileSize(file.size)}</small>
                  </a>
                ))}
                {files.truncated && (
                  <span className="small fg-2">表示上限に達しました</span>
                )}
              </div>
            </section>
          )}
          <Chat
            key={threadKey}
            view={view}
            entries={entries}
            cursor={cursor}
            sending={sending || changingModel || (selected !== null && !view)}
            loading={selected !== null && !view}
            modelPicker={
              <ModelPicker
                label="会話のモデル"
                compact
                value={
                  view?.conversation.modelConfigId
                    ? JSON.stringify([
                        view.conversation.modelConfigId,
                        view.conversation.model ??
                          modelOptions.models.find(
                            (m) => m.id === view.conversation.modelConfigId,
                          )?.model ??
                          modelOptions.catalog[0],
                      ])
                    : draftModel
                }
                models={choices}
                disabled={
                  sending ||
                  changingModel ||
                  (selected !== null && !view) ||
                  currentStatus === "running" ||
                  currentStatus === "stopping"
                }
                onChange={(id) => void changeModel(id)}
                onManage={() => {
                  setSettingsOpen(true);
                }}
              />
            }
            attachments={attachments}
            setAttachments={setAttachments}
            onSend={send}
            onEarlier={earlier}
          />
        </main>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <NotificationProvider>
    <App />
  </NotificationProvider>,
);
