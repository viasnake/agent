import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import hljs from "highlight.js/lib/common";
import { createPortal } from "react-dom";
import {
  ActionBarPrimitive,
  MessagePrimitive,
  MessagePartPrimitive,
  useAuiState,
  useAui,
} from "@assistant-ui/react";
import type {
  TextMessagePartProps,
  ThreadMessageLike,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Entry, Message, View } from "./api.js";
import { Icon } from "./icons.js";
import { MessageActions } from "./message-actions.js";
import { MessageBranches, MessageControlScope } from "./message-controls.js";
import { useNotify } from "./notifications.js";

export const ConversationId = createContext<string | null>(null);

const LinkedImage = createContext(false);

export function conversationThread(entries: Entry[], view: View | null) {
  // Keep durable entry IDs for message actions, including when older pages load.
  const history = [...entries]
    .sort((a, b) => a.id - b.id)
    .flatMap((entry) =>
      entry.messages.map((message, index) => ({
        id: `${entry.id}-${index}`,
        message,
      })),
    );
  type Call = Message["toolCalls"][number];
  const unanswered = new Map<string, Call>();
  const results = new Map<Call, Message>();
  const matchedResults = new Set<Message>();
  for (const { message } of history) {
    for (const call of message.toolCalls) unanswered.set(call.id, call);
    if (!message.toolCallId) continue;
    const call = unanswered.get(message.toolCallId);
    if (!call) continue;
    results.set(call, message);
    matchedResults.add(message);
    unanswered.delete(call.id);
  }
  const progress = view?.progress;
  const liveTools = new Map(progress?.tools.map((tool) => [tool.callId, tool]));
  const runningTools = new Set<string>();
  type Part = Exclude<ThreadMessageLike["content"], string>[number];
  const messages: ThreadMessageLike[] = [];
  let activity: Part[] = [];
  let previousMessage = "start";
  const flushActivity = (open = false) => {
    if (!activity.length) return;
    // Anchor the disclosure before new tool or reasoning parts arrive.
    messages.push({
      id: `activity-${previousMessage}`,
      role: "assistant",
      content: activity,
      metadata: { custom: { activity: true, activityOpen: open } },
    });
    activity = [];
  };
  for (const { id, message } of history) {
    if (message.role === "toolResult") {
      // A result's call can be outside the loaded history page.
      if (matchedResults.has(message)) continue;
      activity.push({
        type: "tool-call",
        toolCallId: message.toolCallId ?? id,
        toolName: message.toolName ?? "",
        args: {},
        argsText: "",
        result: message.content,
        isError: message.isError,
      });
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content: Part[] = [];
    if (message.content.trim())
      (message.visibleInTranscript ? content : activity).push({
        type: "text",
        text: message.content,
      });
    if (message.reasoning.trim())
      activity.push({ type: "reasoning", text: message.reasoning });
    for (const call of message.toolCalls) {
      const result = results.get(call);
      const live =
        unanswered.get(call.id) === call ? liveTools.get(call.id) : undefined;
      if (live?.status === "running") runningTools.add(toolLabel(call.name));
      activity.push({
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.name,
        args: {},
        argsText: call.argsText,
        result: result?.content ?? (live?.output || undefined),
        isError: result?.isError,
        isPreliminary: !result && !!live?.output,
        artifact: live?.status,
      });
    }
    if (!message.visibleInTranscript) continue;
    flushActivity();
    previousMessage = id;
    for (const image of message.images ?? [])
      content.push({ type: "image", image: image.url });
    if (!content.length) continue;
    messages.push({
      id,
      role: message.role,
      createdAt: message.timestamp ? new Date(message.timestamp) : undefined,
      content,
      metadata: { custom: { finalAnswer: message.role === "assistant" } },
    });
  }
  if (progress?.generating && progress.reasoning)
    activity.push({ type: "reasoning", text: progress.reasoning });
  flushActivity(
    view?.conversation.status === "running" ||
      view?.conversation.status === "stopping",
  );
  if (progress?.generating && progress.partial.trim()) {
    messages.push({
      id: "streaming",
      role: "assistant",
      content: [{ type: "text", text: progress.partial }],
      status: { type: "running" },
    });
  }
  return { messages, runningTools: [...runningTools] };
}

function sessionFileUrl(
  id: string | null,
  destination: string | undefined,
  route: "download" | "file-image",
): string | undefined {
  if (!id || !destination || /[?#]/.test(destination)) return;
  let path: string;
  try {
    path = decodeURIComponent(destination.replace(/^\.\//, ""));
  } catch {
    return;
  }
  if (
    !/^(outputs|attachments)\//.test(path) ||
    /[\\\0]/.test(path) ||
    path.split("/").some((part) => !part || part === ".." || part === ".")
  )
    return;
  return `/api/conversations/${id}/${route}?path=${encodeURIComponent(path)}`;
}

const markdownComponents: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ children, className }) => (
    <HighlightedCode className={className}>
      {String(children ?? "")}
    </HighlightedCode>
  ),
  img: function MarkdownImage({ src, alt }) {
    const id = useContext(ConversationId);
    const image = sessionFileUrl(id, src, "file-image");
    return image ? (
      <ImagePreview key={image} image={image} alt={alt ?? ""} />
    ) : (
      <span className="fg-2">{alt ? `[画像：${alt}]` : "[画像]"}</span>
    );
  },
  a: function MarkdownLink({ href, children }) {
    const id = useContext(ConversationId);
    const external = href && /^https?:\/\//i.test(href);
    const url = external ? href : sessionFileUrl(id, href, "download");
    if (!url) return <span>{children}</span>;
    return (
      <a
        href={url}
        target={external ? "_blank" : undefined}
        rel={external ? "noopener noreferrer" : undefined}
      >
        <LinkedImage.Provider value>{children}</LinkedImage.Provider>
      </a>
    );
  },
};

const progressMarkdownComponents: Components = {
  ...markdownComponents,
  img: ({ alt }) => (
    <span className="fg-2">{alt ? `[画像：${alt}]` : "[画像]"}</span>
  ),
};

function MarkdownText({
  text,
  finalAnswer,
}: Pick<TextMessagePartProps, "text"> & { finalAnswer: boolean }) {
  return (
    <div
      className="markdown"
      data-aui-quote-selectable={finalAnswer ? "" : "false"}
    >
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={
          finalAnswer ? markdownComponents : progressMarkdownComponents
        }
      >
        {text}
      </Markdown>
    </div>
  );
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    read: "ファイル読み取り",
    write: "ファイル保存",
    edit: "ファイル編集",
    bash: "コマンド",
    bash_start: "コマンドの開始",
    bash_status: "コマンドの確認",
    bash_stop: "コマンドの停止",
    request_user_input: "選択肢付きの確認",
    memory_save: "記憶の保存",
    memory_update: "記憶の更新",
    memory_forget: "記憶の削除",
    session_search: "過去の会話の検索",
    session_read: "過去の会話の読み取り",
    skill_activate: "Skill の読み込み",
    skill_read_resource: "Skill の資料の読み取り",
  };
  return (
    (Object.hasOwn(labels, name) && labels[name]) ||
    (name.startsWith("mcp_") ? "MCP ツール" : name || "ツール")
  );
}

function ToolActivity({
  toolName,
  argsText,
  result,
  isError,
  isPreliminary,
  artifact,
}: ToolCallMessagePartProps) {
  let status = "結果未確認";
  if (isError) status = "失敗";
  else if (result !== undefined && !isPreliminary) status = "完了";
  else if (artifact === "running") status = "実行中";
  else if (artifact === "pending") status = "待機中";
  return (
    <details
      className="activity-details tool-card"
      data-aui-quote-selectable="false"
    >
      <summary>
        <span>{toolLabel(toolName)}</span>
        <span className={isError ? "ms-2 activity-error" : "ms-2 fg-2"}>
          {status}
        </span>
      </summary>
      {argsText && <pre aria-label="入力">{argsText}</pre>}
      {typeof result === "string" && result && (
        <pre aria-label="出力">{result}</pre>
      )}
    </details>
  );
}

function HighlightedCode({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const tokens = useMemo(() => {
    const language = className?.match(/language-([\w+-]+)/)?.[1];
    if (!language || !hljs.getLanguage(language) || children.length > 16000)
      return children;
    // Only the highlighter's spans become elements. Source HTML stays escaped text;
    // markdown and code never gain an HTML execution path.
    const parsed = new DOMParser().parseFromString(
      hljs.highlight(children, { language, ignoreIllegals: true }).value,
      "text/html",
    );
    function convert(
      node: ChildNode,
      index: number,
    ): import("react").ReactNode {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent;
      if (node instanceof Element && node.tagName === "SPAN")
        return (
          <span key={index} className={node.className}>
            {[...node.childNodes].map(convert)}
          </span>
        );
      return node.textContent;
    }
    return [...parsed.body.childNodes].map(convert);
  }, [children, className]);
  return <code className={className}>{tokens}</code>;
}

export function UserMessage() {
  const message = useAuiState((state) => state.message);
  const entryId = Number(message.id.split("-")[0]);
  const { activeEntry, disabled, onEdit } = useContext(MessageActions);
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editing = draft !== undefined;
  const editor = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (editing) editor.current?.focus({ preventScroll: true });
    else if (editButton.current) {
      editButton.current.focus({ preventScroll: true });
      editButton.current = null;
    }
  }, [editing]);

  function beginEdit() {
    editButton.current = document.activeElement as HTMLElement;
    setError("");
    setDraft(
      message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    );
  }
  const cancel = () => setDraft(undefined);
  const canSubmit = !!draft?.trim() && !disabled && !busy;
  return (
    <MessagePrimitive.Root
      data-entry-id={entryId}
      className={`message user-message ${activeEntry === entryId ? "search-current" : ""}`}
    >
      <div className="visually-hidden">あなた</div>
      {editing ? (
        <form
          className="user-bubble user-editor d-grid gap-2"
          aria-label="メッセージの編集"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape" && !busy) {
              event.stopPropagation();
              cancel();
            } else if (
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey)
            ) {
              event.preventDefault();
              event.currentTarget.requestSubmit();
            }
          }}
          onSubmit={async (event) => {
            event.preventDefault();
            if (!canSubmit || !onEdit) return;
            setBusy(true);
            setError("");
            try {
              await onEdit(entryId, draft);
              setDraft(undefined);
            } catch (error) {
              setError(
                error instanceof Error ? error.message : "送信できませんでした",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <textarea
            ref={editor}
            className="form-control"
            aria-label="メッセージを編集"
            rows={5}
            maxLength={64000}
            value={draft}
            readOnly={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          {message.parts.some((part) => part.type === "image") && (
            <span className="small fg-2">
              <Icon name="attach" /> 元の画像を保持
            </span>
          )}
          {error && <div role="alert">{error}</div>}
          <div className="d-flex flex-wrap justify-content-end gap-2">
            <button
              type="button"
              className="btn-outline theme-secondary btn-sm"
              disabled={busy}
              onClick={cancel}
            >
              キャンセル
            </button>
            <button
              type="submit"
              className="btn-solid theme-primary btn-sm"
              disabled={!canSubmit}
            >
              {busy ? "送信中…" : "送信"}
            </button>
          </div>
        </form>
      ) : (
        <div className="user-bubble">
          <MessagePrimitive.Parts>
            {({ part }) => {
              if (part.type === "text") return <UserText text={part.text} />;
              if (part.type === "image")
                return <ImagePreview image={part.image} />;
              return null;
            }}
          </MessagePrimitive.Parts>
        </div>
      )}
      <div hidden={editing}>
        <MessageFooter user onEdit={beginEdit} />
      </div>
    </MessagePrimitive.Root>
  );
}
function UserText({ text }: { text: string }) {
  const attachments = text.match(
    /\n\n添付：\n((?:attachments\/[0-9a-f-]{36}-[^\n/]+\n?)+)$/i,
  );
  if (!attachments)
    return (
      <MessagePartPrimitive.Text
        className="user-text"
        data-aui-quote-selectable=""
      />
    );
  return (
    <>
      <span className="user-text" data-aui-quote-selectable="">
        {text.slice(0, attachments.index)}
      </span>
      <span className="message-files">
        {attachments[1]!
          .trim()
          .split("\n")
          .map((path) => (
            <span key={path} className="message-file">
              <Icon name="file" />
              {path.replace(/^attachments\/[0-9a-f-]{36}-/i, "")}
            </span>
          ))}
      </span>
    </>
  );
}
export function AssistantMessage() {
  const id = useAuiState((state) => state.message.id);
  const activity = useAuiState(
    (state) => state.message.metadata.custom.activity === true,
  );
  const activityOpen = useAuiState(
    (state) => state.message.metadata.custom.activityOpen === true,
  );
  const finalAnswer = useAuiState(
    (state) => state.message.metadata.custom.finalAnswer === true,
  );
  const { activeEntry } = useContext(MessageActions);
  if (activity)
    return (
      <MessagePrimitive.Root>
        <details
          className="run-details mb-3"
          data-aui-quote-selectable="false"
          open={activityOpen}
        >
          <summary className="small fg-2">実行の詳細</summary>
          <div className="d-grid gap-2 pt-2">
            <AssistantParts finalAnswer={false} />
          </div>
        </details>
      </MessagePrimitive.Root>
    );
  return (
    <MessagePrimitive.Root
      data-entry-id={id === "streaming" ? undefined : id.split("-")[0]}
      className={`message assistant-message ${activeEntry === Number(id.split("-")[0]) ? "search-current" : ""}`}
    >
      <div className="visually-hidden">アシスタント</div>
      <AssistantParts finalAnswer={finalAnswer} />
      {finalAnswer && <MessageFooter />}
    </MessagePrimitive.Root>
  );
}

function AssistantParts({ finalAnswer }: { finalAnswer: boolean }) {
  return (
    <MessagePrimitive.Parts>
      {({ part }) => {
        if (part.type === "text")
          return <MarkdownText text={part.text} finalAnswer={finalAnswer} />;
        if (part.type === "image") return <ImagePreview image={part.image} />;
        if (part.type === "tool-call") return <ToolActivity {...part} />;
        if (part.type === "reasoning")
          return (
            <details
              className="activity-details"
              data-aui-quote-selectable="false"
            >
              <summary>思考の詳細</summary>
              <pre>{part.text}</pre>
            </details>
          );
        return null;
      }}
    </MessagePrimitive.Parts>
  );
}

function MessageFooter({
  user = false,
  onEdit,
}: {
  user?: boolean;
  onEdit?: () => void;
}) {
  return (
    <div className="message-footer" data-aui-quote-selectable="false">
      <MessageBranches />
      <MessageControlScope onEdit={onEdit}>
        <MessageToolbar user={user} />
      </MessageControlScope>
    </div>
  );
}

function MessageToolbar({ user = false }: { user?: boolean }) {
  const aui = useAui();
  const message = useAuiState((state) => state.message);
  const { disabled, onAction, onRemember } = useContext(MessageActions);
  const entryId = Number(message.id.split("-")[0]);
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const timestamp = message.createdAt;
  const isLast = useAuiState(
    (state) => state.thread.messages.at(-1)?.id === state.message.id,
  );
  return (
    <ActionBarPrimitive.Root
      className="message-actions"
      data-last={isLast || undefined}
      hideWhenRunning={false}
    >
      <ActionBarPrimitive.Copy
        className="btn-text theme-secondary btn-sm icon-button copy-action"
        aria-label="メッセージをコピー"
        title="コピー"
      >
        <span className="copy-default">
          <Icon name="copy" />
        </span>
        <span className="copy-done">
          <Icon name="check" />
        </span>
      </ActionBarPrimitive.Copy>
      <button
        className="btn-text theme-secondary btn-sm icon-button"
        aria-label="引用して返信"
        title="引用して返信"
        disabled={!text || message.status?.type === "running"}
        onClick={() => {
          aui.thread().composer().setQuote({ text, messageId: message.id });
        }}
      >
        <Icon name="quote" />
      </button>
      {Number.isFinite(entryId) && (
        <>
          <button
            className="btn-text theme-secondary btn-sm icon-button"
            aria-label="メッセージを記憶"
            title="記憶に保存"
            disabled={!text || disabled}
            onClick={() => onRemember?.(entryId, text)}
          >
            <Icon name="memory" />
          </button>
          <MessageEditOrReload
            user={user}
            className="btn-text theme-secondary btn-sm icon-button"
            aria-label={user ? "メッセージを編集" : "回答を再生成"}
            title={user ? "編集" : "再生成"}
            disabled={disabled}
          >
            <Icon name={user ? "edit" : "retry"} />
          </MessageEditOrReload>
          <button
            className="btn-text theme-secondary btn-sm icon-button"
            aria-label="ここから分岐"
            title="ここから分岐"
            disabled={disabled}
            onClick={() => onAction({ kind: "fork", entryId })}
          >
            <Icon name="fork" />
          </button>
        </>
      )}
      {timestamp && (
        <time
          dateTime={timestamp.toISOString()}
          title={timestamp.toLocaleString("ja-JP")}
        >
          {timestamp.toLocaleTimeString("ja-JP", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      )}
    </ActionBarPrimitive.Root>
  );
}

function MessageEditOrReload({
  user,
  ...props
}: { user: boolean } & import("react").ComponentProps<
  typeof ActionBarPrimitive.Edit
>) {
  return user ? (
    <ActionBarPrimitive.Edit {...props} />
  ) : (
    <ActionBarPrimitive.Reload {...props} />
  );
}

function CodeBlock({ children }: { children?: import("react").ReactNode }) {
  const block = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const notify = useNotify();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="code-block">
      <div className="code-header" data-aui-quote-selectable="false">
        <span>コード</span>
        <button
          className="btn-text theme-secondary btn-sm icon-button"
          aria-label="コードをコピー"
          title="コードをコピー"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                block.current?.textContent ?? "",
              );
              setCopied(true);
            } catch {
              notify("コピーできませんでした", true);
            }
          }}
        >
          <Icon name={copied ? "check" : "copy"} />
        </button>
      </div>
      <pre ref={block}>{children}</pre>
    </div>
  );
}

function ImagePreview({
  image,
  alt = "添付画像",
}: {
  image: string;
  alt?: string;
}) {
  const linked = useContext(LinkedImage);
  const dialog = useRef<HTMLDialogElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <span className="fg-2" role="alert">
        {alt
          ? `${alt}：画像を読み込めませんでした`
          : "画像を読み込めませんでした"}
      </span>
    );
  const thumbnail = (
    <img
      src={image}
      alt={alt}
      className="img-fluid rounded"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
  if (linked) return thumbnail;
  return (
    <>
      <button
        type="button"
        className="image-thumbnail"
        aria-label={alt && alt !== "添付画像" ? `${alt}を拡大` : "画像を拡大"}
        onClick={() => {
          dialog.current?.showModal();
          setExpanded(true);
        }}
      >
        {thumbnail}
        <span>
          <Icon name="expand" />
        </span>
      </button>
      {createPortal(
        <dialog
          ref={dialog}
          className="image-dialog"
          aria-label="画像プレビュー"
          onClose={() => setExpanded(false)}
          onClick={(event) => {
            if (event.target === event.currentTarget) dialog.current?.close();
          }}
        >
          <button
            className="btn-text theme-secondary icon-button"
            aria-label="画像を閉じる"
            title="閉じる"
            autoFocus
            onClick={() => dialog.current?.close()}
          >
            <Icon name="close" />
          </button>
          {expanded && <img src={image} alt={alt || "画像の拡大表示"} />}
        </dialog>,
        document.body,
      )}
    </>
  );
}
