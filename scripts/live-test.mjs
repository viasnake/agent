import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
if (
  process.env.AGENT_LIVE_TEST !== "1" ||
  !process.env.AGENT_LIVE_JOB ||
  !process.env.AGENT_LIVE_PASSWORD_FILE
) {
  console.log(
    JSON.stringify({
      result: "blocked",
      ids: ["W10"],
      reason:
        "Explicit paid-model authorization, an input job file and a private UI credential file are required",
    }),
  );
  process.exit(77);
}
const origin = process.env.AGENT_LIVE_ORIGIN ?? "http://127.0.0.1:8080";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
  throw new Error("Use the explicitly prepared local guest endpoint");
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
if (!login.ok) throw new Error("Live test authentication failed");
const { csrf } = await login.json(),
  cookie = login.headers.get("set-cookie").split(";")[0];
const headers = {
  Origin: origin,
  "Content-Type": "application/json",
  "X-CSRF-Token": csrf,
  Cookie: cookie,
};
const input = JSON.parse(await readFile(process.env.AGENT_LIVE_JOB, "utf8"));
if (input.externalAllowed !== false)
  throw new Error(
    "The live model acceptance command does not authorize external writes",
  );
const response = await fetch(`${origin}/api/jobs`, {
  method: "POST",
  headers,
  body: JSON.stringify({ ...input, requestId: randomUUID() }),
});
if (!response.ok) throw new Error("Live job admission failed");
const { id } = await response.json();
const deadline = Date.now() + 3600000;
while (true) {
  const response = await fetch(`${origin}/api/jobs/${id}`, {
    headers,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("Live job status unavailable");
  const { job } = await response.json();
  if (["succeeded", "failed", "cancelled", "waiting"].includes(job.status)) {
    if (job.status !== "succeeded") {
      console.log(
        JSON.stringify({
          result: job.status === "waiting" ? "blocked" : "fail",
          ids: ["W10"],
          jobId: id,
          status: job.status,
          reason: job.waitReason ?? "Host completion gates did not pass",
        }),
      );
      process.exitCode = job.status === "waiting" ? 77 : 1;
      break;
    }
    const artifacts = job.artifacts.filter(
      (artifact) =>
        !/^(command-|source-|self-review-|pdf-inspection-)/.test(artifact.name),
    );
    if (!artifacts.length) throw new Error("No live deliverables");
    if (process.env.AGENT_LIVE_EVIDENCE_DIR)
      await mkdir(process.env.AGENT_LIVE_EVIDENCE_DIR, {
        recursive: true,
        mode: 0o700,
      });
    for (const artifact of artifacts) {
      const download = await fetch(
        `${origin}/api/artifacts/${artifact.id}/download`,
        { headers },
      );
      if (!download.ok) throw new Error("Live artifact download failed");
      const bytes = Buffer.from(await download.arrayBuffer());
      if (
        bytes.length !== artifact.size ||
        createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
      )
        throw new Error("Live artifact hash mismatch");
      if (process.env.AGENT_LIVE_EVIDENCE_DIR)
        await writeFile(
          join(
            process.env.AGENT_LIVE_EVIDENCE_DIR,
            `${artifact.id}-${artifact.name}`,
          ),
          bytes,
          { flag: "wx", mode: 0o600 },
        );
    }
    console.log(
      JSON.stringify({
        result: "pass",
        ids: ["W10"],
        jobId: id,
        kind: job.kind,
        artifacts: artifacts.map(({ id, sha256, size }) => ({
          id,
          sha256,
          size,
        })),
        limitations:
          "Host gates and downloads passed. Human review of code, citations, Japanese PDF layout and model quality remains required. Run separately for code and research.",
      }),
    );
    break;
  }
  if (Date.now() >= deadline) {
    console.log(
      JSON.stringify({
        result: "blocked",
        ids: ["W10"],
        jobId: id,
        reason: "Timed out; inspect or cancel this exact job in the UI",
      }),
    );
    process.exitCode = 77;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
