import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
function blocked(reason) {
  console.log(JSON.stringify({ result: "blocked", reason }));
  process.exit(77);
}
if (
  process.env.AGENT_LIVE_TEST !== "1" ||
  !process.env.AGENT_LIVE_PROMPT_FILE ||
  !process.env.AGENT_LIVE_PASSWORD_FILE
)
  blocked(
    "Explicit paid-model authorization, a reviewed prompt file and a private UI password file are required",
  );
const origin = process.env.AGENT_LIVE_ORIGIN ?? "http://127.0.0.1:8080";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
  throw new Error("Use the prepared local guest endpoint");
const text = await readFile(process.env.AGENT_LIVE_PROMPT_FILE, "utf8");
if (!text.trim() || text.length > 64000)
  throw new Error("Review a bounded, nonempty prompt");
const login = await fetch(`${origin}/api/login`, {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify({
    requestId: randomUUID(),
    password: (
      await readFile(process.env.AGENT_LIVE_PASSWORD_FILE, "utf8")
    ).trim(),
  }),
});
if (!login.ok) throw new Error("Authentication failed");
const { csrf } = await login.json(),
  headers = {
    Origin: origin,
    "Content-Type": "application/json",
    "X-CSRF-Token": csrf,
    Cookie: login.headers.get("set-cookie").split(";")[0],
  };
const created = await fetch(`${origin}/api/conversations`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    requestId: randomUUID(),
    title: "実モデルの動作確認",
  }),
});
if (!created.ok) throw new Error("Conversation creation failed");
const { id } = await created.json();
const sent = await fetch(`${origin}/api/conversations/${id}/messages`, {
  method: "POST",
  headers,
  body: JSON.stringify({ requestId: randomUUID(), text }),
});
if (!sent.ok)
  blocked(
    "Model, execution boundary or another active conversation prevented dispatch",
  );
const deadline = Date.now() + 3600000;
while (Date.now() < deadline) {
  const response = await fetch(`${origin}/api/conversations/${id}`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("Conversation unavailable");
  const { conversation } = await response.json();
  if (conversation.status === "interrupted")
    blocked(`Conversation ${id} was interrupted; inspect its history`);
  if (conversation.status === "idle") {
    const response = await fetch(`${origin}/api/conversations/${id}/files`, {
      headers,
    });
    if (!response.ok) throw new Error("File listing failed");
    const { files } = await response.json();
    for (const file of files) {
      const download = await fetch(
        `${origin}/api/conversations/${id}/download?path=${encodeURIComponent(file.path)}`,
        { headers },
      );
      if (!download.ok) throw new Error("File download failed");
      await download.arrayBuffer();
    }
    console.log(
      JSON.stringify({
        result: "pass",
        conversationId: id,
        files: files.map((file) => file.path),
        limitations:
          "A finished response and downloadable files do not prove model quality or correctness; inspect the history and results",
      }),
    );
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
blocked(`Conversation ${id} did not finish; inspect or stop it in the UI`);
