import {
  createContext,
  useContext,
  useEffect,
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
  groupPartByType,
  useAuiState,
  useAui,
} from "@assistant-ui/react";
import type {
  TextMessagePartProps,
  ThreadMessageLike,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Entry, View } from "./api.js";
import { Icon } from "./icons.js";
import { MessageActions } from "./message-actions.js";
import { MessageBranches, MessageControlScope } from "./message-controls.js";
import { useNotify } from "./notifications.js";

export const ConversationId = createContext<string | null>(null);

// This is a display adapter only. Tool execution and durable history stay on the server.
export function threadMessages(
  entries: Entry[],
  view: View | null,
): ThreadMessageLike[] {
  const messages = [...entries]
    .sort((a, b) => a.id - b.id)
    .flatMap((entry) =>
      entry.messages.map((message, index) => ({
        ...message,
        id: `${entry.id}-${index}`,
      })),
    );
  const results = new Map(
    messages
      .filter((m) => m.role === "toolResult")
      .map((m) => [m.toolCallId, m]),
  );
  const calls = new Set(
    messages.flatMap((m) => m.toolCalls.map((call) => call.id)),
  );
  const converted: ThreadMessageLike[] = [];
  for (const message of messages) {
    if (message.role === "toolResult" && calls.has(message.toolCallId!))
      continue;
    const content: Exclude<ThreadMessageLike["content"], string>[number][] = [];
    if (message.role === "toolResult") {
      content.push({
        type: "tool-call",
        toolCallId: message.toolCallId ?? message.id,
        toolName: message.toolName ?? "道具",
        args: {},
        argsText: "",
        result: message.content,
        isError: message.isError,
      });
    } else {
      if (message.reasoning?.trim())
        content.push({ type: "reasoning", text: message.reasoning });
      if (message.content.trim())
        content.push({ type: "text", text: message.content });
      for (const image of message.images ?? [])
        content.push({ type: "image", image: image.url });
      for (const call of message.toolCalls) {
        const result = results.get(call.id);
        content.push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.name,
          args: {},
          argsText: call.argsText,
          ...(result
            ? { result: result.content, isError: result.isError }
            : {}),
        });
      }
    }
    if (content.length)
      converted.push({
        id: message.id,
        role: message.role === "user" ? "user" : "assistant",
        ...(message.timestamp
          ? { createdAt: new Date(message.timestamp) }
          : {}),
        content,
      });
  }
  if (view?.progress.partial || view?.progress.reasoning)
    converted.push({
      id: "streaming",
      role: "assistant",
      content: [
        ...(view.progress.reasoning
          ? [{ type: "reasoning" as const, text: view.progress.reasoning }]
          : []),
        ...(view.progress.partial
          ? [{ type: "text" as const, text: view.progress.partial }]
          : []),
      ],
      status: { type: "running" },
    });
  return converted;
}

export function MarkdownText({ text }: Pick<TextMessagePartProps, "text">) {
  const id = useContext(ConversationId);
  return (
    <div className="markdown" data-aui-quote-selectable="">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          code: ({ children, className }) => (
            <HighlightedCode className={className}>
              {String(children ?? "")}
            </HighlightedCode>
          ),
          img: ({ alt }) => (
            <span className="fg-2">{alt ? `[画像：${alt}]` : "[画像]"}</span>
          ),
          a: ({ href, children }) => {
            if (href && /^https?:\/\//i.test(href))
              return (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            const path = href?.replace(/^\.\//, "");
            if (
              id &&
              path?.startsWith("outputs/") &&
              !path.includes("\\") &&
              !path.split("/").some((part) => part === ".." || part === ".")
            )
              return (
                <a
                  href={`/api/conversations/${id}/download?path=${encodeURIComponent(path)}`}
                >
                  {children}
                </a>
              );
            return <span>{children}</span>;
          },
        }}
      >
        {text}
      </Markdown>
    </div>
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

export function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    read: "ファイルを読む",
    write: "ファイルを保存",
    edit: "ファイルを編集",
    bash: "コマンドを実行",
    memory_save: "記憶を保存",
    memory_update: "記憶を更新",
    memory_forget: "記憶を削除",
    session_search: "過去の会話を検索",
    session_read: "過去の会話を読む",
  };
  return labels[name] ?? (name.startsWith("mcp_") ? "MCP ツール" : name);
}

function ToolResult({
  toolName,
  argsText,
  result,
  isError,
}: ToolCallMessagePartProps) {
  const running = useAuiState((state) => state.thread.isRunning);
  return (
    <details
      className={`tool-card ${isError ? "tool-error" : ""}`}
      data-aui-quote-selectable="false"
    >
      <summary>
        <Icon name="terminal" />
        <span className="tool-name">{toolLabel(toolName)}</span>
        <span className="tool-state">
          {isError
            ? "失敗"
            : result === undefined
              ? running
                ? "実行中"
                : "結果未確認"
              : "実行結果"}
        </span>
      </summary>
      <div className="tool-detail-label">入力</div>
      <pre>
        {toolName}
        {argsText ? `\n${argsText}` : ""}
      </pre>
      {result !== undefined && (
        <>
          <div className="tool-detail-label">出力</div>
          <pre>
            {typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2)}
          </pre>
        </>
      )}
    </details>
  );
}
export function UserMessage() {
  const id = useAuiState((state) => state.message.id);
  const { activeEntry } = useContext(MessageActions);
  return (
    <MessagePrimitive.Root
      data-entry-id={id.split("-")[0]}
      className={`message user-message ${activeEntry === Number(id.split("-")[0]) ? "search-current" : ""}`}
    >
      <div className="visually-hidden">あなた</div>
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
      <MessageFooter user />
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
  const hasText = useAuiState((state) =>
    state.message.parts.some(
      (part) => part.type === "text" && part.text.trim(),
    ),
  );
  const id = useAuiState((state) => state.message.id);
  const { activeEntry } = useContext(MessageActions);
  return (
    <MessagePrimitive.Root
      data-entry-id={id.split("-")[0]}
      className={`message assistant-message ${activeEntry === Number(id.split("-")[0]) ? "search-current" : ""}`}
    >
      <div className="visually-hidden">アシスタント</div>
      <div className="assistant-content">
        <MessagePrimitive.GroupedParts
          groupBy={groupPartByType({
            reasoning: ["group-thinking"],
            "tool-call": ["group-thinking"],
          })}
          indicator="never"
        >
          {({ part, children }) => {
            if (part.type === "group-thinking")
              return (
                <ChainOfThought indices={part.indices}>
                  {children}
                </ChainOfThought>
              );
            if (part.type === "reasoning")
              return (
                <div
                  className="reasoning-text"
                  data-aui-quote-selectable="false"
                >
                  {part.text}
                </div>
              );
            if (part.type === "text") return <MarkdownText text={part.text} />;
            if (part.type === "tool-call") return <ToolResult {...part} />;
            return null;
          }}
        </MessagePrimitive.GroupedParts>
      </div>
      {hasText && <MessageFooter />}
    </MessagePrimitive.Root>
  );
}

function ChainOfThought({
  children,
  indices,
}: {
  children: import("react").ReactNode;
  indices: readonly number[];
}) {
  const running = useAuiState(
    (state) =>
      state.message.status?.type === "running" ||
      (state.thread.isRunning &&
        indices.some((index) => {
          const part = state.message.parts[index];
          return part?.type === "tool-call" && part.result === undefined;
        })),
  );
  const failed = useAuiState((state) =>
    indices.some((index) => {
      const part = state.message.parts[index];
      return part?.type === "tool-call" && part.isError;
    }),
  );
  return (
    <details className="chain-of-thought" data-aui-quote-selectable="false">
      <summary>
        <Icon name="chevron" />
        <span>{running ? "思考中…" : "思考・ツール"}</span>
        {failed && <span className="thinking-error">ツール失敗</span>}
      </summary>
      <div className="thinking-parts">{children}</div>
    </details>
  );
}

function MessageFooter({ user = false }: { user?: boolean }) {
  return (
    <div className="message-footer" data-aui-quote-selectable="false">
      <MessageBranches />
      <MessageControlScope>
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
            onClick={() =>
              onAction({ kind: "fork", entryId, text, images: false })
            }
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

export function ImagePreview({ image }: { image: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [failed, setFailed] = useState(false);
  return (
    <>
      {failed ? (
        <span role="alert">画像を読み込めませんでした</span>
      ) : (
        <button
          type="button"
          className="image-thumbnail"
          aria-label="画像を拡大"
          onClick={() => dialog.current?.showModal()}
        >
          <img
            src={image}
            alt="添付画像"
            className="img-fluid rounded"
            loading="lazy"
            onError={() => setFailed(true)}
          />
          <span>
            <Icon name="expand" />
          </span>
        </button>
      )}
      {createPortal(
        <dialog
          ref={dialog}
          className="image-dialog"
          aria-label="画像プレビュー"
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
          <img src={image} alt="添付画像の拡大表示" />
        </dialog>,
        document.body,
      )}
    </>
  );
}
