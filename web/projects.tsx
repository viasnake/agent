import { RecentPosts } from "./project-timeline.js";
import type { PortfolioPost } from "../src/project-timeline.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectRow } from "../src/projects.js";
import { api, forget, requestId } from "./api.js";
import { Icon } from "./icons.js";

export const projectStatusLabels = {
  decision: "判断待ち",
  working: "進行中",
  delivered: "完了報告",
  waiting: "完了報告なし",
  interrupted: "中断",
  draft: "依頼前",
};
const memberLabels = {
  queued: "待機中",
  running: "作業中",
  reported: "報告済み",
  failed: "実行失敗",
  interrupted: "中断",
};
function StateLabel({ status }: { status: ProjectRow["status"] }) {
  return (
    <span className={"project-state state-" + status}>
      <i />
      {projectStatusLabels[status]}
    </span>
  );
}
export function ProjectTeamStatus({ project: p }: { project: ProjectRow }) {
  return (
    <details className="project-team-detail">
      <summary>
        担当と進捗{" "}
        <span>
          {p.members.filter((m) => m.status === "reported").length} /{" "}
          {p.members.length} 件報告済み
        </span>
      </summary>
      {p.assessment && (
        <p>
          <strong>完了報告の照合 </strong>
          {p.assessment.verdict === "checking"
            ? "確認中"
            : p.assessment.verdict === "revise"
              ? "責任者へ差し戻し"
              : "確認済み"}
          {p.assessment.reason && " · " + p.assessment.reason}
        </p>
      )}
      {p.summary && <p>{p.summary}</p>}
      {p.evidence && (
        <p>
          <strong>完了の根拠 </strong>
          {p.evidence}
        </p>
      )}
      <ul>
        {p.members.map((m) => (
          <li key={m.id}>
            <b>{m.role}</b> · {memberLabels[m.status]}
            <div>{m.task}</div>
            {m.status === "running" && <div>{m.activity}</div>}
            {m.report && <p>{m.report}</p>}
            {m.check && (
              <details>
                <summary>テスト{m.check.passed ? "成功" : "失敗"}</summary>
                <pre>
                  {m.check.command && "$ " + m.check.command + "\n"}
                  {m.check.output || "出力なし"}
                </pre>
              </details>
            )}
            {m.file && (
              <a
                href={`/api/conversations/${p.id}/download?path=${encodeURIComponent(m.file)}`}
              >
                採用したパッチを保存
              </a>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
export function ProjectDashboard({
  onOpen,
  onNew,
  onMenu,
}: {
  onOpen: (id: string) => void;
  onNew: () => void;
  onMenu: () => void;
}) {
  const [showActivity, setShowActivity] = useState(false),
    [activity, setActivity] = useState<PortfolioPost[] | null>(null);
  const [rows, setRows] = useState<ProjectRow[] | null>(null),
    [error, setError] = useState(""),
    [answerError, setAnswerError] = useState(""),
    [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<"active" | "delivered" | "archived">(
    "active",
  );
  const alive = useRef(false),
    generation = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try {
      const result = await api<{ projects: ProjectRow[] }>(
        "/api/project-dashboard",
      );
      const feed = showActivity
        ? await api<{ posts: PortfolioPost[] }>(
            "/api/project-dashboard/activity",
          )
        : undefined;
      if (alive.current && version === generation.current) {
        if (feed) setActivity(feed.posts);
        setRows(result.projects);
        setError("");
      }
    } catch (e) {
      if (alive.current && version === generation.current)
        setError(e instanceof Error ? e.message : "進捗を取得できませんでした");
    }
  }, [showActivity]);
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>,
      disposed = false;
    const poll = async () => {
      if (!document.hidden) await refresh();
      if (!disposed) timer = setTimeout(() => void poll(), 3500);
    };
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    void poll();
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      alive.current = false;
      generation.current++;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  async function decide(p: ProjectRow, option: number) {
    if (!p.question || busy) return;
    const choice = { entryId: p.question.entryId, option },
      key = `choice-${p.id}-${choice.entryId}`;
    setBusy(p.id);
    setAnswerError("");
    try {
      await api(`/api/conversations/${p.id}/choices`, "POST", {
        requestId: await requestId(key, choice),
        choice,
      });
      forget(key);
    } catch (e) {
      setAnswerError(e instanceof Error ? e.message : "回答を送れませんでした");
    } finally {
      await refresh();
      setBusy(null);
    }
  }
  const all = rows ?? [],
    current = all.filter((p) => !p.archived),
    decisions = current.filter((p) => p.status === "decision"),
    groups = {
      active: current.filter((p) => p.status !== "delivered"),
      delivered: current.filter((p) => p.status === "delivered"),
      archived: all.filter((p) => p.archived),
    };
  const visible = groups[filter];
  return (
    <main className="project-dashboard" aria-labelledby="projects-heading">
      <header className="projects-header">
        <button
          className="mobile-only btn-text theme-secondary btn-sm"
          onClick={onMenu}
          aria-label="セッション一覧を開く"
        >
          <Icon name="menu" />
        </button>
        <h1 id="projects-heading">プロジェクト</h1>
        <button className="btn-solid theme-primary" onClick={onNew}>
          <Icon name="plus" /> 新しい依頼
        </button>
      </header>
      <div className="project-body">
        {error && (
          <p role="alert">
            {error}{" "}
            <button
              className="btn-text theme-primary"
              onClick={() => void refresh()}
            >
              再読み込み
            </button>
          </p>
        )}
        {answerError && <p role="alert">{answerError}</p>}
        {!rows && !error && <p role="status">進捗を読み込み中…</p>}
        {rows && (
          <>
            <section
              aria-labelledby="decisions-heading"
              className="decision-desk"
            >
              <h2 id="decisions-heading">
                あなたの判断待ち <span>{decisions.length}</span>
              </h2>
              {decisions.length === 0 ? (
                <p>現在、回答が必要な案件はありません。</p>
              ) : (
                decisions.map((p) => (
                  <article className="decision-request" key={p.id}>
                    <button
                      className="project-link"
                      onClick={() => onOpen(p.id)}
                    >
                      {p.title}
                    </button>
                    <p>{p.question!.question}</p>
                    <div>
                      {p.question!.options.map((o, i) => (
                        <button
                          key={i}
                          className="btn-outline theme-secondary btn-sm"
                          disabled={!!busy}
                          onClick={() => void decide(p, i)}
                        >
                          {o}
                        </button>
                      ))}
                    </div>
                  </article>
                ))
              )}
            </section>
            <section aria-labelledby="portfolio-heading">
              <div className="portfolio-heading">
                <h2 id="portfolio-heading">
                  {showActivity ? "最近の報告" : "案件一覧"}
                </h2>
                <div
                  className="portfolio-switch"
                  role="group"
                  aria-label="案件の表示"
                >
                  <button
                    aria-pressed={!showActivity}
                    onClick={() => setShowActivity(false)}
                  >
                    案件一覧
                  </button>
                  <button
                    aria-pressed={showActivity}
                    onClick={() => setShowActivity(true)}
                  >
                    報告フィード
                  </button>
                </div>
              </div>
              {showActivity ? (
                activity ? (
                  <RecentPosts posts={activity} onOpen={onOpen} />
                ) : (
                  !error && <p role="status">報告を読み込み中…</p>
                )
              ) : (
                <>
                  <div
                    className="portfolio-filter"
                    role="group"
                    aria-label="表示する案件"
                  >
                    {(["active", "delivered", "archived"] as const).map(
                      (value, i) => (
                        <button
                          key={value}
                          aria-pressed={filter === value}
                          onClick={() => setFilter(value)}
                        >
                          {["対応中", "完了報告", "アーカイブ"][i]}{" "}
                          <span>{groups[value].length}</span>
                        </button>
                      ),
                    )}
                  </div>
                  {visible.length === 0 ? (
                    <p className="project-empty">
                      {all.length
                        ? "該当する案件はありません。"
                        : "「新しい依頼」から目的を伝えると、ここで担当と進捗を追えます。"}
                    </p>
                  ) : (
                    visible.map((p) => (
                      <article key={p.id} className="portfolio-item">
                        <div className="portfolio-top">
                          <StateLabel status={p.status} />
                          <time dateTime={new Date(p.updatedAt).toISOString()}>
                            {new Intl.DateTimeFormat("ja-JP", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            }).format(p.updatedAt)}
                          </time>
                        </div>
                        <h3>
                          <button
                            className="project-link"
                            onClick={() => onOpen(p.id)}
                          >
                            {p.title}
                            <Icon name="right" />
                          </button>
                        </h3>
                        <p className="portfolio-summary">
                          {p.status === "working" &&
                          p.assessment?.verdict === "checking"
                            ? "完了報告の根拠を照合しています。"
                            : p.status === "working" &&
                                p.assessment?.verdict === "revise"
                              ? "責任者が報告を見直しています。" +
                                p.assessment.reason
                              : p.summary ||
                                (p.status === "interrupted"
                                  ? p.detail
                                  : p.instruction !== p.title
                                    ? p.instruction
                                    : "") ||
                                (p.status === "working"
                                  ? "責任者が依頼を確認しています。"
                                  : p.status === "draft"
                                    ? "最初の指示を待っています。"
                                    : "責任者の進捗報告はまだありません。")}
                        </p>
                        {p.members.length > 0 && (
                          <div className="project-members">
                            {p.members.map((m) => (
                              <span key={m.id}>
                                {m.role}
                                <small>
                                  {m.status === "running"
                                    ? m.activity
                                    : memberLabels[m.status]}
                                </small>
                              </span>
                            ))}
                          </div>
                        )}
                        {(p.members.length > 0 ||
                          p.evidence ||
                          p.assessment) && <ProjectTeamStatus project={p} />}
                      </article>
                    ))
                  )}
                </>
              )}
            </section>
          </>
        )}
      </div>
    </main>
  );
}
