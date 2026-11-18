import { useState } from "react";
import { api } from "./api.js";
import type { View } from "./api.js";
import { useNotify } from "./notifications.js";

const states = {
  open: "作業中",
  checking: "確認中",
  needs_user: "要判断",
  done: "完了",
  paused: "停止中",
};
export function CoordinatorWork({
  value,
  onSelect,
}: {
  value: NonNullable<View["coordination"]>;
  onSelect: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);
  const notify = useNotify();
  const requests = value.requests.filter((r) =>
    completed ? r.state === "done" : r.state !== "done",
  );
  async function control(action: "stop" | "resume") {
    setBusy(true);
    try {
      await api(`/api/coordinator/${action}`, "POST", {});
    } catch (error) {
      notify((error as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="border-bottom px-3 py-2" aria-label="任せている作業">
      <summary>
        作業 {requests.length}
        {value.paused ? " · 自動継続を停止中" : ""}
      </summary>
      <div className="d-flex gap-2 my-2">
        <button
          className="btn-outline theme-secondary btn-sm"
          disabled={busy}
          onClick={() => void control(value.paused ? "resume" : "stop")}
        >
          {value.paused ? "自動継続を許可" : "すべて停止"}
        </button>
        <button
          className="btn-text theme-secondary btn-sm"
          aria-pressed={completed}
          onClick={() => setCompleted(!completed)}
        >
          {completed ? "未完了を表示" : "完了を表示"}
        </button>
      </div>
      {requests.map((r) => (
        <div key={r.id} className="border rounded p-2 mb-2">
          <div className="d-flex gap-2">
            <strong className="text-truncate">{r.objective}</strong>
            <span className="badge badge-subtle theme-secondary">
              {states[r.state]}
            </span>
          </div>
          <div className="small">
            呼出 {r.calls}/{r.maxCalls} · {r.tokens.toLocaleString()} tokens ·{" "}
            {r.cost === null ? "N/A" : `$${r.cost.toFixed(4)}`}
          </div>
          <div className="d-flex flex-wrap gap-2 mt-1">
            {r.sessionIds.map((id) => {
              const child = value.sessions.find((s) => s.id === id);
              return (
                child && (
                  <button
                    key={id}
                    className="btn-text theme-primary btn-sm"
                    onClick={() => onSelect(id)}
                  >
                    {child.title} ·{" "}
                    {child.paused
                      ? "停止中"
                      : value.pending.some((p) => p.sessionId === id)
                        ? "実行待ち"
                        : child.status === "running"
                          ? "実行中"
                          : "開く"}
                  </button>
                )
              );
            })}
          </div>
          {!!r.resultRefs.length && (
            <ul className="small mb-0">
              {r.resultRefs.map((ref, i) => (
                <li key={i}>{ref}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </details>
  );
}
