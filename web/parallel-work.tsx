import { useState } from "react";
import type { WorkView } from "../src/parallel-work.js";
import { api } from "./api.js";
const states = {
  queued: "待機中",
  running: "実行中",
  pausing: "一時停止待ち",
  paused: "一時停止",
  cancelling: "取消中",
  cancelled: "取消済み",
  failed: "失敗",
  passed: "検証済み",
  ready: "変更を作成済み",
  interrupted: "中断",
};
export function ParallelWork({
  work,
  session,
}: {
  work: WorkView;
  session: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const url = `/api/conversations/${session}/work/${work.id}`;
  const action = async (action: "pause" | "resume" | "cancel") => {
    setPending(true);
    setError("");
    try {
      await api(url + "/control", "POST", { action });
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作に失敗しました");
    } finally {
      setPending(false);
    }
  };
  const check = work.candidate?.checks.at(-1);
  return (
    <section className="conversation-notice d-grid gap-2" aria-label="並列作業">
      <strong>{work.goal}</strong>
      <span role="status">{states[work.status]}</span>
      <ul className="mb-0">
        {work.assignments.map((a) => {
          const t = a.attempts.at(-1);
          return (
            <li key={a.path}>
              <code>{a.path}</code> ·{" "}
              {t ? `${states[t.state]}（${t.number}回目）` : "待機中"}
            </li>
          );
        })}
      </ul>
      {work.detail && <span>{work.detail}</span>}
      <details>
        <summary>検証内容</summary>
        <p>
          基点 <code>{work.base}</code>
        </p>
        <code>{work.check}</code>
        {work.candidate && (
          <p>
            対象ツリー <code>{work.candidate.tree}</code>
          </p>
        )}
        {check && <p>{states[check.status]}</p>}
        {check?.output && <pre className="overflow-auto">{check.output}</pre>}
      </details>
      <div className="d-flex flex-wrap gap-2">
        {work.status === "passed" && check?.status === "passed" && (
          <a href={url + "/patch/" + work.candidate!.id} download>
            検証済みの差分を保存
          </a>
        )}
        {work.status === "running" && (
          <button
            className="btn-outline theme-secondary btn-sm"
            disabled={pending}
            onClick={() => void action("pause")}
          >
            一時停止
          </button>
        )}
        {["failed", "paused"].includes(work.status) && (
          <button
            className="btn-outline theme-primary btn-sm"
            disabled={pending}
            onClick={() => void action("resume")}
          >
            再開
          </button>
        )}
        {["running", "pausing", "paused", "failed"].includes(work.status) && (
          <button
            className="btn-outline theme-secondary btn-sm"
            disabled={pending}
            onClick={() => void action("cancel")}
          >
            作業を取り消す
          </button>
        )}
      </div>
      {error && <span role="alert">{error}</span>}
    </section>
  );
}
