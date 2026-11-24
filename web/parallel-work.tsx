import { useEffect, useState } from "react";
import type { WorkView } from "../src/parallel-work.js";
import { GitPatch } from "./git-patch.js";
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
function CandidateDiff({
  url,
  label,
  status,
}: {
  url: string;
  label: string;
  status?: string;
}) {
  const [open, setOpen] = useState(false),
    [retry, setRetry] = useState(0);
  const [value, setValue] = useState<{
    patch: string;
    checks: { status: keyof typeof states; output: string }[];
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError("");
    void api<NonNullable<typeof value>>(
      url,
      "GET",
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) setValue(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : "差分を取得できませんでした",
          );
      });
    return () => controller.abort();
  }, [url, open, retry, status]);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{label}</summary>
      {open &&
        (error ? (
          <div role="alert">
            {error}{" "}
            <button
              className="btn-outline theme-secondary btn-sm"
              onClick={() => setRetry((n) => n + 1)}
            >
              再読み込み
            </button>
          </div>
        ) : value ? (
          <>
            <GitPatch text={value.patch} showFiles />
            {value.checks.length > 0 && (
              <ol aria-label="検証履歴">
                {value.checks.map((c, i) => (
                  <li key={i}>
                    {states[c.status]}
                    {c.output && (
                      <pre className="overflow-auto">{c.output}</pre>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : (
          <span role="status">差分を読み込み中…</span>
        ))}
    </details>
  );
}
export function ParallelWork({
  work,
  session,
}: {
  work: WorkView;
  session: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [repairPath, setRepairPath] = useState(""),
    [guidance, setGuidance] = useState("");
  const [exported, setExported] = useState<{
    candidate: string;
    path: string;
  } | null>(null);
  const url = `/api/conversations/${session}/work/${work.id}`;
  const action = async (
    action: "pause" | "resume" | "cancel" | "repair" | "export",
  ) => {
    setPending(true);
    setError("");
    try {
      if (action === "export" && work.candidate) {
        const result = await api<{ path: string }>(
          url + "/candidates/" + work.candidate.id + "/export",
          "POST",
          {},
        );
        setExported({ candidate: work.candidate.id, path: result.path });
      } else {
        await api(
          url + "/control",
          "POST",
          action === "repair"
            ? {
                action,
                path: repairPath,
                guidance: guidance.trim(),
                revision: work.revision,
              }
            : { action },
        );
        if (action === "repair") setGuidance("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作に失敗しました");
    } finally {
      setPending(false);
    }
  };
  const check = work.candidate?.checks.at(-1);
  return (
    <section className="parallel-work" aria-label="並列作業">
      <header className="parallel-work-heading">
        <strong>{work.goal}</strong>
        <span
          className="parallel-work-status"
          data-status={work.status}
          role="status"
        >
          {states[work.status]}
        </span>
      </header>
      <ul className="parallel-work-files">
        {work.assignments.map((a) => {
          const t = a.attempts.at(-1);
          return (
            <li key={a.path}>
              <code>{a.path}</code>
              <span>
                {t ? `${states[t.state]}（${t.number}回目）` : "待機中"}
              </span>
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
      {work.candidates.map((c) => (
        <CandidateDiff
          key={c.id}
          url={url + "/candidates/" + c.id}
          status={c.status}
          label={
            c.id === work.candidate?.id
              ? "差分を確認"
              : `以前の差分（${c.tree.slice(0, 8)}・${c.status ? states[c.status] : "未検証"}）`
          }
        />
      ))}
      {work.status === "failed" && (
        <details>
          <summary>担当に修正を依頼</summary>
          <form
            className="parallel-work-repair"
            onSubmit={(e) => {
              e.preventDefault();
              void action("repair");
            }}
          >
            <label>
              修正対象
              <select
                className="form-select"
                required
                value={repairPath}
                onChange={(e) => setRepairPath(e.target.value)}
              >
                <option value="">ファイルを選択</option>
                {work.assignments.map((a) => (
                  <option key={a.path} value={a.path}>
                    {a.path}
                  </option>
                ))}
              </select>
            </label>
            <label>
              修正指示
              <textarea
                className="form-control"
                required
                maxLength={2000}
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
              />
            </label>
            <button
              className="btn-outline theme-primary btn-sm"
              disabled={pending || !repairPath || !guidance.trim()}
            >
              この担当を再実行
            </button>
          </form>
        </details>
      )}
      <div className="parallel-work-actions">
        {work.status === "passed" && check?.status === "passed" && (
          <a href={url + "/patch/" + work.candidate!.id} download>
            検証済みの差分を保存
          </a>
        )}
        {work.status === "passed" &&
          work.candidate &&
          (exported?.candidate === work.candidate.id ? (
            <code role="status" className="text-break">
              {exported.path}
            </code>
          ) : (
            <button
              className="btn-outline theme-secondary btn-sm"
              disabled={pending}
              onClick={() => void action("export")}
            >
              作業フォルダに保存
            </button>
          ))}
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
            {work.status === "failed" && work.candidate
              ? "同じ差分を再検証"
              : "再開"}
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
