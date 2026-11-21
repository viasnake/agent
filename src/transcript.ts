import type { Message } from "@earendil-works/pi-ai";

export function isConversationMessage(message: Message): boolean {
  if (message.role === "user") return true;
  if (message.role !== "assistant") return false;
  // Pi ends a turn on these reasons, except when toolUse starts another round.
  return (
    message.stopReason === "stop" ||
    message.stopReason === "length" ||
    (message.stopReason === "toolUse" &&
      !message.content.some((part) => part.type === "toolCall"))
  );
}

export function messageText(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}
