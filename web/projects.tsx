import { ProjectAnswer, ProjectDeliverable } from "./project-response.js";
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
        {p.members.length ? "担当と進捗" : "照合結果と根拠"}{" "}
        {p.members.length > 0 && (
          <span>
            {p.members.filter((m) => m.status === "reported").length} /{" "}
            {p.members.length} 件報告済み
          </span>
        )}
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
      {p.assessment &&
        "sources" in p.assessment &&
        p.assessment.sources?.map(({ label, quote }) => (
          <blockquote className="work-source" key={quote}>
            <strong>{label}</strong>
            {quote}
          </blockquote>
        ))}
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
const updatedTime = new Intl.DateTimeFormat("ja-JP", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function ProjectCard({
  project: p,
  onOpen,
}: {
  project: ProjectRow;
  onOpen: (id: string) => void;
}) {
  const sent = p.status === "delivered";
  const note =
    p.status === "interrupted"
      ? p.detail
      : p.assessment?.verdict === "revise"
        ? p.assessment.reason
        : p.summary || (p.instruction !== p.title ? p.instruction : "");
  const patches = sent ? p.members.filter((m) => m.file) : [];
  return (
    <article className="work-card">
      <div className="portfolio-top">
        <StateLabel status={p.status} />
        <time dateTime={new Date(p.updatedAt).toISOString()}>
          {updatedTime.format(p.updatedAt)}
        </time>
      </div>
      <h3>
        <button className="project-link" onClick={() => onOpen(p.id)}>
          {p.title}
        </button>
      </h3>
      {note && <p className="portfolio-summary">{note}</p>}
      {p.status === "working" && p.nextStep && (
        <p className="work-next">
          <strong>次の作業</strong>
          {p.nextStep}
        </p>
      )}
      {!sent && p.members.length > 0 && (
        <div className="work-members">
          {p.members.map((m) => (
            <span key={m.id}>
              {m.role}
              <small>{memberLabels[m.status]}</small>
            </span>
          ))}
        </div>
      )}
      {p.deliveryPost && (
        <ProjectDeliverable
          key={p.deliveryPost}
          session={p.id}
          postId={p.deliveryPost}
        />
      )}
      {patches.map((m) => (
        <a
          className="work-file"
          key={m.id}
          href={`/api/conversations/${p.id}/download?path=${encodeURIComponent(m.file!)}`}
        >
          <Icon name="file" />
          {patches.length > 1
            ? m.role + "のパッチを保存"
            : "採用したパッチを保存"}
        </a>
      ))}
      {(p.members.length > 0 ||
        (!p.deliveryPost && (p.evidence || p.assessment))) && (
        <ProjectTeamStatus project={p} />
      )}
    </article>
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
  const [mode, setMode] = useState<"home" | "list" | "activity">("home"),
    [activity, setActivity] = useState<PortfolioPost[] | null>(null);
  const [rows, setRows] = useState<ProjectRow[] | null>(null),
    [error, setError] = useState(""),
    [answerError, setAnswerError] = useState(""),
    [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<"active" | "delivered" | "archived">(
    "active",
  );
  const showActivity = mode === "activity";
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
  async function decide(p: ProjectRow, option: number | string) {
    if (!p.question || busy) return;
    const entryId = p.question.entryId,
      choice =
        typeof option === "string"
          ? { entryId, answer: option }
          : { entryId, option },
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
  const working = current.filter((p) => p.status === "working"),
    stopped = current.filter(
      (p) => p.status === "interrupted" || p.status === "waiting",
    ),
    drafts = current.filter((p) => p.status === "draft");
  function card(p: ProjectRow) {
    return <ProjectCard key={p.id} project={p} onOpen={onOpen} />;
  }

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
            <nav className="work-nav" aria-label="プロジェクトの表示">
              {(
                [
                  ["home", "仕事のホーム"],
                  ["list", "案件一覧"],
                  ["activity", "報告フィード"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={mode === value}
                  onClick={() => setMode(value)}
                >
                  {label}
                </button>
              ))}
            </nav>
            {mode === "home" && (
              <>
                <section
                  className={
                    "work-decisions" + (decisions.length ? " needs-answer" : "")
                  }
                  aria-labelledby="decisions-heading"
                >
                  <h2 id="decisions-heading">
                    <Icon name="chat" />
                    あなたの判断待ち <span>{decisions.length}</span>
                  </h2>
                  {decisions.length === 0 ? (
                    <p className="work-empty">
                      現在、回答が必要な案件はありません。
                    </p>
                  ) : (
                    decisions.map((p) => (
                      <article className="decision-request" key={p.id}>
                        <button
                          className="project-link"
                          onClick={() => onOpen(p.id)}
                        >
                          {p.title}
                        </button>
                        <h3>{p.question!.question}</h3>
                        {p.assessment &&
                          "sources" in p.assessment &&
                          p.assessment.sources?.map(({ label, quote }) => (
                            <blockquote className="work-source" key={quote}>
                              <strong>{label}</strong>
                              {quote}
                            </blockquote>
                          ))}
                        {p.summary && <p>{p.summary}</p>}
                        <ProjectAnswer
                          key={p.question!.entryId}
                          question={p.question!}
                          busy={!!busy}
                          onAnswer={(value) => void decide(p, value)}
                        />
                      </article>
                    ))
                  )}
                </section>
                <div className="work-columns">
                  <section
                    aria-labelledby="work-running-heading"
                    className="work-column"
                  >
                    <h2 id="work-running-heading">
                      <Icon name="fork" />
                      チームが進めている案件 <span>{working.length}</span>
                    </h2>
                    {working.length ? (
                      working.map(card)
                    ) : (
                      <p className="work-empty">進行中の案件はありません。</p>
                    )}
                    {stopped.length > 0 && (
                      <section className="work-stopped">
                        <h2>
                          中断・要確認 <span>{stopped.length}</span>
                        </h2>
                        {stopped.map(card)}
                      </section>
                    )}
                    {drafts.length > 0 && (
                      <section className="work-stopped">
                        <h2>
                          依頼前 <span>{drafts.length}</span>
                        </h2>
                        {drafts.map(card)}
                      </section>
                    )}
                  </section>
                  <section
                    aria-labelledby="work-results-heading"
                    className="work-column"
                  >
                    <h2 id="work-results-heading">
                      <Icon name="file" />
                      届いた成果物 <span>{groups.delivered.length}</span>
                    </h2>
                    {groups.delivered.length ? (
                      groups.delivered.slice(0, 4).map(card)
                    ) : (
                      <p className="work-empty">納品された案件はありません。</p>
                    )}
                    {groups.delivered.length > 4 && (
                      <button
                        className="btn-text theme-primary"
                        onClick={() => {
                          setFilter("delivered");
                          setMode("list");
                        }}
                      >
                        すべての納品を見る
                      </button>
                    )}
                  </section>
                </div>
              </>
            )}
            {mode === "activity" && (
              <section aria-label="最近の報告">
                {activity ? (
                  <RecentPosts posts={activity} onOpen={onOpen} />
                ) : (
                  !error && <p role="status">報告を読み込み中…</p>
                )}
              </section>
            )}
            {mode === "list" && (
              <section aria-label="案件一覧">
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
                {visible.length ? (
                  visible.map(card)
                ) : (
                  <p className="work-empty">該当する案件はありません。</p>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
