import { createContext, useContext } from "react";
import {
  ActionBarPrimitive,
  MessagePrimitive,
  useAuiState,
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
      if (message.content.trim())
        content.push({ type: "text", text: message.content });
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
        content,
      });
  }
  if (view?.progress.partial)
    converted.push({
      id: "streaming",
      role: "assistant",
      content: view.progress.partial,
      status: { type: "running" },
    });
  return converted;
}

export function MarkdownText({ text }: Pick<TextMessagePartProps, "text">) {
  const id = useContext(ConversationId);
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
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

export function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    read: "ファイルを読む",
    write: "ファイルを保存",
    edit: "ファイルを編集",
    bash: "コマンドを実行",
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
    <details className={`tool-card ${isError ? "tool-error" : ""}`}>
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
      <pre>
        {toolName}
        {argsText ? `\n${argsText}` : ""}
      </pre>
      {result !== undefined && (
        <pre>
          {typeof result === "string"
            ? result
            : JSON.stringify(result, null, 2)}
        </pre>
      )}
    </details>
  );
}
export function UserMessage() {
  return (
    <MessagePrimitive.Root className="message user-message">
      <div className="message-label">あなた</div>
      <div className="user-bubble">
        <MessagePrimitive.Parts
          components={{
            Text: ({ text }) => <span className="user-text">{text}</span>,
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}
export function AssistantMessage() {
  const hasText = useAuiState((state) =>
    state.message.parts.some(
      (part) => part.type === "text" && part.text.trim(),
    ),
  );
  return (
    <MessagePrimitive.Root className="message assistant-message">
      <div className="message-label">
        <span className="agent-avatar">
          <Icon name="agent" />
        </span>
        Agent
      </div>
      <MessagePrimitive.Parts
        components={{ Text: MarkdownText, tools: { Fallback: ToolResult } }}
      />
      {hasText && (
        <ActionBarPrimitive.Root className="message-actions">
          <ActionBarPrimitive.Copy className="btn-text theme-secondary btn-sm">
            コピー
          </ActionBarPrimitive.Copy>
        </ActionBarPrimitive.Root>
      )}
    </MessagePrimitive.Root>
  );
}
