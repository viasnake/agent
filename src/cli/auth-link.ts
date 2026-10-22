import { hyperlink } from "@earendil-works/pi-tui";
import { AgentError } from "../types.js";

export function chatGPTLoginLink(value: string, interactive: boolean): string {
  const url = new URL(value);
  if (
    url.origin !== "https://auth.openai.com" ||
    url.pathname !== "/api/accounts/authorize" ||
    url.username ||
    url.password ||
    /[\x00-\x20\x7f]/.test(value)
  )
    throw new AgentError("AUTH", "Unexpected ChatGPT authorization URL");

  // Bind the complete URL to a short label; terminal URL detection can truncate
  // long OAuth queries. Keep a plain URL for terminals that ignore OSC 8 links.
  const link = interactive
    ? hyperlink("Continue with ChatGPT (auth.openai.com)", url.href) + "\n\n"
    : "";
  return (
    link +
    "リンクを開けない場合は、次の URL 全体をコピーしてブラウザーに貼り付けてください。\n" +
    url.href +
    "\n"
  );
}
