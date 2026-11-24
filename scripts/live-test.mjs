import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
function blocked(reason) {
  console.log(JSON.stringify({ result: "blocked", reason }));
  process.exit(77);
}
if (process.env.AGENT_LIVE_TEST !== "1" || !process.env.AGENT_LIVE_PROMPT_FILE)
  blocked(
    "Explicit paid-model authorization and a reviewed prompt file are required",
  );
const parallel = process.argv.includes("--parallel-work");
const project = process.argv.includes("--project");
if (
  (parallel && project) ||
  process.argv
    .slice(2)
    .some((arg) => !["--parallel-work", "--project"].includes(arg))
)
  throw new Error("Unknown live test option");
const origin = process.env.AGENT_LIVE_ORIGIN ?? "http://127.0.0.1:8080";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
  throw new Error("Use the configured local application endpoint");
const text = await readFile(process.env.AGENT_LIVE_PROMPT_FILE, "utf8");
if (!text.trim() || text.length > 64000)
  throw new Error("Review a bounded, nonempty prompt");
const session = await fetch(`${origin}/api/session`);
if (!session.ok) throw new Error("Local session unavailable");
const { csrf } = await session.json(),
  headers = {
    Origin: origin,
    "Content-Type": "application/json",
    "X-CSRF-Token": csrf,
    Cookie: session.headers.get("set-cookie").split(";")[0],
  };
const created = await fetch(`${origin}/api/conversations`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    requestId: randomUUID(),
    title: "実モデルの動作確認",
    ...(project ? { managedProject: true } : {}),
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
  const { conversation, work, project: thread } = await response.json();
  if (conversation.status === "interrupted")
    blocked(`Conversation ${id} was interrupted; inspect its history`);
  if (conversation.status === "idle" && project) {
    const portfolio = await fetch(origin + "/api/projects", { headers });
    if (!portfolio.ok) throw new Error("Project portfolio unavailable");
    const dashboard = (await portfolio.json()).projects.find(
      (row) => row.id === id,
    );
    if (dashboard?.status === "decision")
      blocked("Project is waiting for your decision: " + id);
    if (
      !thread ||
      dashboard?.status !== "delivered" ||
      thread.status !== "delivered" ||
      dashboard.assessment?.verdict !== "accept" ||
      thread.assessment?.verdict !== "accept"
    )
      throw new Error("The project has no reviewed delivery: " + id);
    const members = thread.members.filter((m) => m.status === "reported");
    if (members.length < 2)
      throw new Error(
        "The directive did not result in two specialist reports: " + id,
      );
    for (const member of members.filter((m) => m.file)) {
      const file = await fetch(
        origin +
          "/api/conversations/" +
          id +
          "/download?path=" +
          encodeURIComponent(member.file),
        { headers },
      );
      if (
        !member.check?.passed ||
        !file.ok ||
        !(await file.arrayBuffer()).byteLength
      )
        throw new Error("Missing checked deliverable: " + id);
    }
    console.log(
      JSON.stringify({
        result: "pass",
        conversationId: id,
        revision: thread.revision,
        roles: members.map((m) => m.role),
        assessment: thread.assessment.verdict,
        checkedPatches: members.filter((m) => m.file).length,
      }),
    );
    process.exit(0);
  }
  if (conversation.status === "idle" && parallel) {
    const item = work?.at(-1);
    if (!item)
      throw new Error("The reviewed prompt did not produce parallel work");
    if (item.status === "failed" || item.status === "cancelled")
      throw new Error(
        `Work ${item.id} ended with ${item.status}: ${item.detail}`,
      );
    if (item.status === "paused")
      blocked(`Work ${item.id} is paused; inspect its history`);
    if (item.status === "passed") {
      const candidate = item.candidate;
      if (!candidate || candidate.checks.at(-1)?.status !== "passed")
        throw new Error("Missing successful candidate check");
      const route = `${origin}/api/conversations/${id}/work/${item.id}`;
      const stored = await fetch(`${route}/patch/${candidate.id}`, { headers });
      const exported = await fetch(
        `${route}/candidates/${candidate.id}/export`,
        { method: "POST", headers, body: "{}" },
      );
      if (!stored.ok || !exported.ok)
        throw new Error("Verified patch delivery failed");
      const bytes = Buffer.from(await stored.arrayBuffer());
      const { path, sha256 } = await exported.json();
      const download = await fetch(
        `${origin}/api/conversations/${id}/download?path=${encodeURIComponent(path)}`,
        { headers },
      );
      if (
        !download.ok ||
        bytes.length === 0 ||
        createHash("sha256").update(bytes).digest("hex") !== sha256 ||
        !bytes.equals(Buffer.from(await download.arrayBuffer()))
      )
        throw new Error("Workspace patch differs from checked bytes");
      console.log(
        JSON.stringify({
          result: "pass",
          conversationId: id,
          base: item.base,
          tree: candidate.tree,
          check: item.check,
          paths: item.assignments.map((a) => a.path),
          sha256,
        }),
      );
      process.exit(0);
    }
  } else if (conversation.status === "idle") {
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
