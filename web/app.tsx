import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js";
import { useReadingPosition } from "./reading-position.js";
import { NotificationProvider, useNotify } from "./notifications.js";
import { ModelPicker } from "./model-picker.js";
import { SessionList } from "./sessions.js";
import { MessageActions, MessageActionDialog } from "./message-actions.js";
import type { MessageAction } from "./message-actions.js";
import { readDraft, saveDraft } from "./drafts.js";
import { ConversationSearch } from "./search.js";
import type { MemoryDraft, MemorySource } from "./memory.js";
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
  draftId: string | null;
  view: View | null;
  entries: Entry[];
  cursor: unknown;
  modelPicker: ReactNode;
  loading: boolean;
  loadError: string;
  onRetry: () => void;
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
      className="btn-solid theme-primary btn-sm ms-auto icon-button send-button"
      aria-label={sending ? "送信中…" : "送る"}
      title="送信（Ctrl / ⌘ + Enter）"
      aria-busy={sending}
      disabled={!canSend || sending}
      onClick={() => aui.composer().send()}
    >
      <Icon name={sending ? "retry" : "send"} />
    </button>
  );
}
function Chat({
  draftId,
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
  loadError,
  onRetry,
}: ThreadProps) {
  const notify = useNotify();
  const viewport = useReadingPosition();
  const draftFailure = useRef(false);
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
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    runtime.thread.composer.setText(readDraft(draftId));
    return runtime.thread.composer.subscribe(() => {
      if (
        !saveDraft(draftId, runtime.thread.composer.getState().text) &&
        !draftFailure.current
      ) {
        draftFailure.current = true;
        notify(
          "下書きを保存できません。画面を閉じる前にコピーしてください",
          true,
        );
      }
    });
  }, [runtime, draftId, notify]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ConversationId.Provider value={view?.conversation.id ?? null}>
        <ThreadPrimitive.Root
          className={`chat-thread ${!messages.length && !loading ? "chat-empty" : ""} ${dragging ? "drop-target" : ""}`}
          onDragOver={(event) => {
            if (!sending && event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={(event) => {
            if (
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            )
              setDragging(false);
          }}
          onDrop={(event) => {
            setDragging(false);
            if (sending || !event.dataTransfer.files.length) return;
            event.preventDefault();
            setAttachments(
              [...attachments, ...event.dataTransfer.files].slice(0, 20),
            );
          }}
        >
          <ThreadPrimitive.Viewport
            ref={viewport}
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
              {loadError && (
                <div className="conversation-notice" role="alert">
                  <span>{loadError}</span>
                  <button
                    className="btn-outline theme-secondary btn-sm"
                    onClick={onRetry}
                  >
                    再読み込み
                  </button>
                </div>
              )}
              {!messages.length && !loading && !loadError && (
                <div className="empty-thread">
                  <span className="empty-icon">
                    <Icon name="agent" />
                  </span>
                  <h2>何を始めますか？</h2>
                </div>
              )}
              {/* Keep the load control and prepended messages on the same runtime update. */}
              <ThreadPrimitive.LoadEarlier
                id="earlier"
                className="btn-text theme-secondary btn-sm mb-5"
              >
                以前の記録
              </ThreadPrimitive.LoadEarlier>
              <ThreadPrimitive.Messages>
                {({ message }) =>
                  message.role === "user" ? (
                    <UserMessage />
                  ) : (
                    <AssistantMessage />
                  )
                }
              </ThreadPrimitive.Messages>
              {view?.conversation.status === "interrupted" && (
                <div id="detail" className="conversation-notice" role="status">
                  {view.conversation.detail}
                </div>
              )}
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
                onPaste={(event) => {
                  if (!sending && event.clipboardData.files.length) {
                    event.preventDefault();
                    setAttachments(
                      [...attachments, ...event.clipboardData.files].slice(
                        0,
                        20,
                      ),
                    );
                  }
                }}
                autoFocus
              />
              {attachments.length > 0 && (
                <div className="attachment-chips">
                  {attachments.map((file, index) => (
                    <span key={index} className="attachment-chip">
                      <AttachmentIcon file={file} />
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

function AttachmentIcon({ file }: { file: File }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    setUrl("");
    if (
      ![
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "image/avif",
      ].includes(file.type) ||
      file.size > 20 * 1024 * 1024
    )
      return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url ? (
    <img className="attachment-preview" src={url} alt="" />
  ) : (
    <Icon name="file" />
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
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState<MemoryDraft | null>(null);
  const memoryTarget = useRef<{ sessionId: string; entryId?: number } | null>(
    null,
  );
  const [ready, setReady] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  const selectionVersion = useRef(0);
  const [reload, setReload] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<View | null>(null);
  const [messageAction, setMessageAction] = useState<MessageAction | null>(
    null,
  );
  const messageActionOrigin = useRef<HTMLElement | null>(null);
  const [activeEntry, setActiveEntry] = useState<number | null>(null);
  const attachmentDrafts = useRef(new Map<string, File[]>());
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<unknown>(null);
  const [files, setFiles] = useState<Files>({ files: [] });
  const [tab, setTab] = useState<"chat" | "files">("chat");
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState("");
  const filesVersion = useRef(0);
  const listVersion = useRef(0);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
    const version = ++listVersion.current;
    const result = await api<{ conversations: Conversation[] }>(
      "/api/conversations",
    );
    if (listVersion.current === version) setConversations(result.conversations);
  }, []);
  const refreshFiles = useCallback(
    async (id: string) => {
      const version = selectionVersion.current;
      const request = ++filesVersion.current;
      const isCurrent = () =>
        selectedRef.current === id &&
        selectionVersion.current === version &&
        filesVersion.current === request;
      setFilesLoading(true);
      setFilesError("");
      try {
        const result = await api<Files>(`/api/conversations/${id}/files`);
        if (isCurrent()) setFiles(result);
      } catch (error) {
        if (!isCurrent()) return;
        if (error instanceof ApiError && error.status === 401) notice(error);
        else setFilesError("ファイルを読み込めませんでした");
      } finally {
        if (isCurrent()) setFilesLoading(false);
      }
    },
    [notice],
  );
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
    setSearchOpen(false);
    setSettingsOpen(false);
    setSidebar(false);
    // Reselecting the visible conversation must preserve its subscription and draft.
    if (id !== null && selectedRef.current === id) return;
    attachmentDrafts.current.set(selectedRef.current ?? "new", attachments);
    selectionVersion.current++;
    setReload((value) => value + 1);
    selectedRef.current = id;
    setSelected(id);
    setView(null);
    setEntries([]);
    setCursor(null);
    setFiles({ files: [] });
    setFilesLoading(false);
    setFilesError("");
    setTab("chat");
    setAttachments(attachmentDrafts.current.get(id ?? "new") ?? []);
    setActiveEntry(null);
    setError("");
    setLoadError("");
    setThreadKey((key) => key + 1);
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
        const failures = options.models.filter((model) => model.error);
        if (failures.length)
          notify(
            failures
              .map((model) => `${model.name}: ${model.error}`)
              .join(" / "),
            true,
          );
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
  }, [ready, settingsOpen, notice, notify]);
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
    let snapshotReceived = false;
    let historyInitialized = false;
    const version = selectionVersion.current;
    const isCurrent = () => active && selectionVersion.current === version;
    const id = selected;
    setLoadError("");
    setConnection("接続中");
    const events = new EventSource(`/api/conversations/${id}/events`);
    void api<View>(`/api/conversations/${id}`)
      .then((next) => {
        if (isCurrent()) {
          // The initial HTTP response can arrive after a newer live snapshot.
          if (!snapshotReceived) merge(next);
          if (!historyInitialized) setCursor(next.cursor);
          historyInitialized = true;
        }
      })
      .catch((error) => {
        if (!isCurrent()) return;
        if (error instanceof ApiError && error.status === 401) notice(error);
        else if (!snapshotReceived)
          setLoadError("セッションを読み込めませんでした");
      });
    events.addEventListener("snapshot", (event) => {
      if (!isCurrent()) return;
      const next: View = JSON.parse((event as MessageEvent).data);
      if (!historyInitialized) setCursor(next.cursor);
      historyInitialized = true;
      snapshotReceived = true;
      setLoadError("");
      merge(next);
    });
    events.onopen = () => {
      if (isCurrent()) setConnection("接続中");
    };
    events.onerror = () => {
      if (isCurrent()) setConnection("再接続中");
    };
    return () => {
      active = false;
      events.close();
    };
  }, [ready, selected, reload, merge, notice]);
  const currentStatus = view?.conversation.status;
  useEffect(() => {
    if (!ready || !selected) return;
    void list().catch(notice);
    void refreshFiles(selected).catch(notice);
  }, [ready, selected, currentStatus, list, refreshFiles, notice]);
  useEffect(() => {
    if (!sidebar) return;
    const close = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !document.querySelector(":popover-open, dialog[open]")
      )
        setSidebar(false);
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
        saveDraft(null, "");
        attachmentDrafts.current.delete("new");
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
        requestId: await requestId(key, {
          text: content,
          ...(paths.length ? { attachments: paths } : {}),
        }),
        text: content,
        ...(paths.length ? { attachments: paths } : {}),
      });
      forget(key);
      forget("create");
      saveDraft(id, "");
      for (const file of attached) forget(`upload-${id}-${file.name}`);
      setAttachments([]);
      await api<View>(`/api/conversations/${id}`).then(merge).catch(notice);
      await list().catch(notice);
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) forget("create");
      notice(error);
      throw error;
    } finally {
      setSending(false);
    }
  }
  async function earlier() {
    if (!selected || !cursor) return;
    const version = selectionVersion.current;
    try {
      const encoded = btoa(JSON.stringify(cursor))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const next = await api<View>(
        `/api/conversations/${selected}?cursor=${encodeURIComponent(encoded)}`,
      );
      if (
        selectedRef.current !== selected ||
        selectionVersion.current !== version
      )
        return;
      // Older pages extend the transcript without replacing the current execution state.
      setEntries((previous) => [
        ...new Map(
          [...next.transcript, ...previous].map((entry) => [entry.id, entry]),
        ).values(),
      ]);
      setCursor(next.cursor);
    } catch (error) {
      if (selectionVersion.current === version) notice(error);
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
  async function deleteSession(session: Conversation) {
    if (sending || acting || deleting) return;
    const id = session.id;
    setDeleting(true);
    try {
      await api(`/api/conversations/${id}`, "DELETE", {});
      // A failed first send can leave its creation request saved for retry.
      if (selectedRef.current === id) forget("create");
      saveDraft(id, "");
      if (selectedRef.current === id) select(null);
      attachmentDrafts.current.delete(id);
      setConversations((items) => items.filter((item) => item.id !== id));
      await list().catch(notice);
      notify("セッションを削除しました");
    } finally {
      setDeleting(false);
    }
  }
  async function renameSession(session: Conversation, title: string) {
    await updateSession(session, { title });
    notify("名前を変更しました");
  }
  async function updateSession(
    session: Conversation,
    change: { title?: string; pinned?: boolean; archived?: boolean },
  ) {
    const updated = await api<Conversation>(
      `/api/conversations/${session.id}`,
      "PATCH",
      change,
    );
    setConversations((sessions) =>
      sessions.map((item) =>
        item.id === updated.id ? { ...item, ...change } : item,
      ),
    );
    setView((view) =>
      view?.conversation.id === updated.id
        ? { ...view, conversation: { ...view.conversation, ...change } }
        : view,
    );
  }
  async function branchMessage(text: string) {
    if (!selected || !messageAction) return;
    const sourceId = selected;
    const body = { entryId: messageAction.entryId, mode: messageAction.kind };
    const key = `branch-${sourceId}`;
    try {
      const branch = await api<{ id: string }>(
        `/api/conversations/${sourceId}/branch`,
        "POST",
        { ...body, requestId: await requestId(key, { ...body, text }) },
      );
      // Creation and execution have separate durable receipts. A lost response never
      // authorizes another inference or tool mutation with a different identity.
      if (messageAction.kind !== "fork") {
        const sendKey = `branch-send-${branch.id}`;
        const content =
          messageAction.kind === "edit"
            ? {
                text,
                source: { sessionId: sourceId, entryId: messageAction.entryId },
              }
            : {};
        await api(
          `/api/conversations/${branch.id}/${messageAction.kind === "edit" ? "messages" : "continue"}`,
          "POST",
          { ...content, requestId: await requestId(sendKey, content) },
        );
        forget(sendKey);
      }
      forget(key);
      select(branch.id);
    } finally {
      await list().catch(notice);
    }
  }
  async function jumpTo(entryId: number) {
    if (!selected) return;
    const id = selected,
      version = selectionVersion.current;
    let nextCursor = cursor;
    const loaded = [...entries];
    for (
      let page = 0;
      !loaded.some((entry) => entry.id === entryId) && nextCursor && page < 40;
      page++
    ) {
      const encoded = btoa(JSON.stringify(nextCursor))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const next = await api<View>(
        `/api/conversations/${id}?cursor=${encodeURIComponent(encoded)}`,
      );
      if (selectedRef.current !== id || selectionVersion.current !== version)
        return;
      loaded.push(...next.transcript);
      nextCursor = next.cursor;
    }
    setEntries((old) => [
      ...new Map(
        [...old, ...loaded].map((entry) => [entry.id, entry]),
      ).values(),
    ]);
    setCursor(nextCursor);
    if (!loaded.some((entry) => entry.id === entryId))
      throw new Error("履歴の読み込み上限に達しました");
    setTab("chat");
    setActiveEntry(entryId);
    requestAnimationFrame(() => {
      if (selectedRef.current !== id || selectionVersion.current !== version)
        return;
      const viewport = document.getElementById("transcript");
      const target = viewport?.querySelector<HTMLElement>(
        `[data-entry-id="${entryId}"]`,
      );
      if (viewport && target) {
        const bounds = viewport.getBoundingClientRect();
        const message = target.getBoundingClientRect();
        // Only the transcript may scroll; scrollIntoView also moves clipped ancestors.
        viewport.scrollTo({
          top:
            viewport.scrollTop +
            message.top -
            bounds.top -
            Math.max(0, (viewport.clientHeight - message.height) / 2),
          behavior: "instant",
        });
      }
    });
  }
  useEffect(() => {
    const target = memoryTarget.current;
    if (settingsOpen || !target || view?.conversation.id !== target.sessionId)
      return;
    memoryTarget.current = null;
    if (target.entryId) void jumpTo(target.entryId).catch(notice);
  }, [view?.conversation.id, settingsOpen]);
  function openMemory(draft: MemoryDraft) {
    setMemoryDraft(draft);
    setSettingsOpen(true);
    setSidebar(false);
  }
  async function openSource(source: MemorySource) {
    if (selectedRef.current === source.sessionId && !settingsOpen) {
      if (source.entryId) await jumpTo(source.entryId);
      setTab("chat");
      setSidebar(false);
    } else {
      await api<View>(`/api/conversations/${source.sessionId}`);
      memoryTarget.current = source;
      setSettingsOpen(false);
      setTab("chat");
      setSidebar(false);
      if (selectedRef.current !== source.sessionId) select(source.sessionId);
    }
  }
  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "f" &&
        selected
      ) {
        event.preventDefault();
        setTab("chat");
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [selected]);
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
    <div
      id="app"
      className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}
    >
      {sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="セッション一覧を閉じる"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside
        id="sidebar"
        className={`sidebar ${sidebar ? "sidebar-open" : ""}`}
      >
        <div className="sidebar-header">
          <button
            className="sidebar-close btn-text theme-secondary btn-sm icon-button"
            aria-label="セッション一覧を閉じる"
            title="一覧を閉じる"
            onClick={() => setSidebar(false)}
          >
            <Icon name="close" />
          </button>
          <button
            id="new-conversation"
            className="btn-text theme-secondary new-conversation"
            disabled={sending || deleting}
            onClick={() => select(null)}
          >
            <Icon name="plus" />
            新しいセッション
          </button>
        </div>
        <SessionList
          sessions={conversations.map((session) =>
            session.id === view?.conversation.id ? view.conversation : session,
          )}
          selected={selected}
          disabled={sending || deleting}
          onSelect={select}
          onOpenSource={openSource}
          onRename={renameSession}
          onDelete={deleteSession}
          onUpdate={(session, change) =>
            updateSession(session, change).catch(notice)
          }
        />
        <div className="sidebar-footer">
          <button
            className="btn-text theme-secondary btn-sm"
            onClick={() => {
              setMemoryDraft(null);
              setSettingsOpen(true);
              setSidebar(false);
            }}
          >
            <Icon name="settings" />
            設定
          </button>
          {connection !== "接続中" && (
            <span id="connection" className="small fg-2" role="status">
              {connection}
            </span>
          )}
        </div>
      </aside>
      <div className="workspace-stack">
        {settingsOpen && (
          <Settings
            memoryDraft={memoryDraft}
            onSelectSource={openSource}
            onClose={() => {
              setSettingsOpen(false);
              setMemoryDraft(null);
              history.replaceState(null, "", location.pathname);
            }}
          />
        )}
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as typeof tab)}
          asChild
        >
          <main
            className="workspace"
            aria-hidden={settingsOpen}
            inert={settingsOpen}
          >
            <header className="conversation-header">
              <button
                className="desktop-only btn-text theme-secondary btn-sm icon-button"
                aria-label={
                  collapsed ? "セッション一覧を開く" : "セッション一覧を閉じる"
                }
                title={collapsed ? "一覧を開く" : "一覧を閉じる"}
                aria-expanded={!collapsed}
                aria-controls="sidebar"
                onClick={() => setCollapsed(!collapsed)}
              >
                <Icon name="sidebar" />
              </button>
              <button
                className="mobile-only btn-text theme-secondary btn-sm"
                aria-label="セッション一覧を開く"
                aria-expanded={sidebar}
                aria-controls="sidebar"
                onClick={() => setSidebar(!sidebar)}
              >
                <Icon name="menu" />
              </button>
              <h1 id="title">
                {view?.conversation.title ?? "新しいセッション"}
              </h1>
              {view?.conversation.parentId && (
                <button
                  className="btn-text theme-secondary btn-sm icon-button"
                  aria-label="元のセッションを開く"
                  title="元のセッション"
                  onClick={() => select(view.conversation.parentId!)}
                >
                  <Icon name="fork" />
                </button>
              )}
              {view && (
                <span
                  id="state"
                  className={`badge badge-subtle ${currentStatus === "running" ? "theme-primary" : "theme-secondary"}`}
                >
                  {statuses[currentStatus!] ?? currentStatus}
                </span>
              )}
              <div id="actions" className="ms-auto">
                {selected && (
                  <button
                    className="btn-text theme-secondary btn-sm icon-button"
                    aria-label="会話内を検索"
                    title="会話内を検索（Ctrl / ⌘ + Shift + F）"
                    onClick={() => {
                      setTab("chat");
                      setSearchOpen(true);
                    }}
                  >
                    <Icon name="search" />
                  </button>
                )}
                {(currentStatus === "running" ||
                  currentStatus === "interrupted") && (
                  <button
                    className="btn-outline theme-secondary btn-sm icon-button"
                    aria-label={currentStatus === "running" ? "停止" : "再開"}
                    title={currentStatus === "running" ? "停止" : "再開"}
                    disabled={acting || deleting}
                    onClick={() => void action()}
                  >
                    <Icon
                      name={currentStatus === "running" ? "stop" : "retry"}
                    />
                  </button>
                )}
              </div>
            </header>
            <TabsList className="session-tabs" aria-label="セッションの内容">
              <TabsTrigger
                value="chat"
                id="chat-tab"
                aria-controls="chat-panel"
              >
                <Icon name="chat" />
                会話
              </TabsTrigger>
              <TabsTrigger
                value="files"
                id="files-tab"
                aria-controls="files-panel"
              >
                <Icon name="file" />
                ファイル
              </TabsTrigger>
            </TabsList>
            <div className="session-panels">
              <TabsContent
                value="files"
                forceMount
                id="files-panel"
                aria-labelledby="files-tab"
                aria-hidden={tab !== "files"}
                inert={tab !== "files"}
                className="session-panel"
                tabIndex={0}
              >
                <section
                  id="files-section"
                  className="output-files"
                  aria-label="ファイル"
                >
                  <div className="output-label">
                    <Icon name="file" />
                    <span>ファイル</span>
                    <button
                      id="refresh-files"
                      className="btn-text theme-secondary btn-sm icon-button"
                      aria-label="更新"
                      title="更新"
                      disabled={!selected || filesLoading}
                      onClick={() => selected && void refreshFiles(selected)}
                    >
                      <Icon name="retry" />
                    </button>
                  </div>
                  {filesLoading && <p role="status">読み込み中…</p>}
                  {filesError && <p role="alert">{filesError}</p>}
                  {!filesLoading && !filesError && !files.files.length && (
                    <p className="files-empty">ファイルはありません</p>
                  )}
                  <div id="files">
                    {files.files.map((file) => (
                      <a
                        key={file.path}
                        className="output-file"
                        href={`/api/conversations/${selected}/download?path=${encodeURIComponent(file.path)}`}
                      >
                        <Icon name="down" />
                        <span>
                          {file.path.startsWith("attachments/")
                            ? file.path.replace(
                                /^attachments\/[0-9a-f-]{36}-/i,
                                "",
                              )
                            : file.path.slice(8)}
                        </span>
                        <small>
                          {file.path.startsWith("attachments/")
                            ? "添付"
                            : "生成"}
                        </small>
                        <small>{fileSize(file.size)}</small>
                      </a>
                    ))}
                    {files.truncated && (
                      <span className="small fg-2">表示上限に達しました</span>
                    )}
                  </div>
                </section>
              </TabsContent>
              <TabsContent
                value="chat"
                forceMount
                id="chat-panel"
                aria-labelledby="chat-tab"
                aria-hidden={tab !== "chat"}
                inert={tab !== "chat"}
                className="session-panel"
              >
                {searchOpen && selected && (
                  <ConversationSearch
                    id={selected}
                    onClose={() => {
                      setSearchOpen(false);
                      document
                        .getElementById("message")
                        ?.focus({ preventScroll: true });
                    }}
                    onSelect={jumpTo}
                  />
                )}
                <MessageActions.Provider
                  value={{
                    disabled:
                      sending ||
                      changingModel ||
                      acting ||
                      deleting ||
                      currentStatus === "running" ||
                      currentStatus === "stopping",
                    activeEntry,
                    onRemember: (entryId, text) => {
                      if (selected)
                        openMemory({
                          text,
                          source: { sessionId: selected, entryId },
                        });
                    },
                    onAction: (action) => {
                      messageActionOrigin.current =
                        document.activeElement as HTMLElement;
                      setMessageAction(action);
                    },
                  }}
                >
                  <Chat
                    draftId={selected}
                    key={threadKey}
                    view={view}
                    entries={entries}
                    cursor={cursor}
                    sending={
                      sending ||
                      deleting ||
                      changingModel ||
                      (selected !== null && !view)
                    }
                    loading={selected !== null && !view && !loadError}
                    loadError={loadError}
                    onRetry={() => {
                      setLoadError("");
                      setReload((value) => value + 1);
                    }}
                    modelPicker={
                      <ModelPicker
                        label="セッションのモデル"
                        compact
                        value={
                          view?.conversation.modelConfigId
                            ? JSON.stringify([
                                view.conversation.modelConfigId,
                                view.conversation.model ??
                                  modelOptions.models.find(
                                    (m) =>
                                      m.id === view.conversation.modelConfigId,
                                  )?.model,
                              ])
                            : draftModel
                        }
                        models={choices}
                        disabled={
                          sending ||
                          deleting ||
                          changingModel ||
                          (selected !== null && !view) ||
                          currentStatus === "running" ||
                          currentStatus === "stopping"
                        }
                        onChange={(id) => void changeModel(id)}
                        onManage={() => {
                          setMemoryDraft(null);
                          setSettingsOpen(true);
                        }}
                      />
                    }
                    attachments={attachments}
                    setAttachments={setAttachments}
                    onSend={send}
                    onEarlier={earlier}
                  />
                </MessageActions.Provider>
              </TabsContent>
            </div>
            {messageAction && (
              <MessageActionDialog
                action={messageAction}
                onClose={() => {
                  setMessageAction(null);
                  if (messageActionOrigin.current?.isConnected)
                    messageActionOrigin.current.focus({ preventScroll: true });
                  else
                    document
                      .getElementById("message")
                      ?.focus({ preventScroll: true });
                }}
                onSubmit={branchMessage}
              />
            )}
          </main>
        </Tabs>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <NotificationProvider>
    <App />
  </NotificationProvider>,
);
