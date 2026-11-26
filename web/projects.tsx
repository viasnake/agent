import { ProjectTeamStatus } from "./project-team.js";
import { ProjectAnswer, ProjectDeliverable } from "./project-response.js";
import { RecentPosts } from "./project-timeline.js";
import type { PortfolioPost } from "../src/project-timeline.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectRow } from "../src/projects.js";
import { api, forget, requestId } from "./api.js";
import { Icon } from "./icons.js";

export const projectStatusLabels = {
  decision: "回答待ち",
  working: "進行中",
  delivered: "完了",
  waiting: "未完了",
  interrupted: "中断",
  draft: "依頼前",
};
function StateLabel({ status }: { status: ProjectRow["status"] }) {
  return (
    <span className={"project-state state-" + status}>
      <i />
      {projectStatusLabels[status]}
    </span>
  );
}
const updatedTime = new Intl.DateTimeFormat("ja-JP", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function TopicBoard({
  rows,
  onOpen,
}: {
  rows: ProjectRow[];
  onOpen: (id: string) => void;
}) {
  const topics = [...rows].sort(
    (a, b) =>
      (b.lastPostedAt ?? 0) - (a.lastPostedAt ?? 0) ||
      b.updatedAt - a.updatedAt ||
      a.id.localeCompare(b.id),
  );
  return (
    <table className="topic-board" aria-label="スレッド一覧">
      <thead>
        <tr>
          <th scope="col">スレッド</th>
          <th scope="col">状態</th>
          <th scope="col">投稿数</th>
          <th scope="col">最終投稿</th>
        </tr>
      </thead>
      <tbody>
        {topics.map((p) => {
          const excerpt =
            p.status === "decision"
              ? p.question?.question
              : p.status === "interrupted"
                ? p.detail
                : p.summary;
          return (
            <tr key={p.id}>
              <th scope="row">
                <a
                  href={"?project=" + encodeURIComponent(p.id)}
                  onClick={(event) => {
                    if (
                      event.ctrlKey ||
                      event.metaKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    event.preventDefault();
                    onOpen(p.id);
                  }}
                >
                  {p.title}
                </a>
                {excerpt && <p>{excerpt}</p>}
              </th>
              <td>
                <StateLabel status={p.status} />
              </td>
              <td className="topic-count">{p.postCount}</td>
              <td>
                {p.lastPostedAt ? (
                  <time dateTime={new Date(p.lastPostedAt).toISOString()}>
                    {updatedTime.format(p.lastPostedAt)}
                  </time>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ProjectCard({
  project: p,
  onOpen,
  showStatus,
}: {
  showStatus: boolean;
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
  const updated = new Date(p.updatedAt);
  const patches = sent ? p.members.filter((m) => m.file) : [];
  return (
    <article className="work-card">
      <div className="card-heading">
        <h3>
          <button className="project-link" onClick={() => onOpen(p.id)}>
            {p.title}
          </button>
        </h3>
        <time
          dateTime={updated.toISOString()}
          title={updatedTime.format(updated)}
        >
          {updated.toDateString() === new Date().toDateString()
            ? updated.toLocaleTimeString("ja-JP", {
                hour: "2-digit",
                minute: "2-digit",
              })
            : updatedTime.format(updated)}
        </time>
      </div>
      {showStatus && <StateLabel status={p.status} />}
      {note && <p className="portfolio-summary">{note}</p>}
      {p.status === "working" && p.nextStep && (
        <p className="work-next">
          <strong>次の作業</strong>
          {p.nextStep}
        </p>
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
          {patches.length > 1 ? m.role + "のパッチを保存" : "パッチを保存"}
        </a>
      ))}
      {(p.members.length > 0 ||
        (!p.deliveryPost && (p.evidence || p.assessment))) && (
        <ProjectTeamStatus project={p} showSummary={note !== p.summary} />
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
  type Mode = "home" | "list" | "activity";
  const [mode, setMode] = useState<Mode>(() => {
      const key = new URLSearchParams(location.search).get("projects");
      return key === "board"
        ? "list"
        : key === "activity"
          ? "activity"
          : "home";
    }),
    [activity, setActivity] = useState<PortfolioPost[] | null>(null);
  const [rows, setRows] = useState<ProjectRow[] | null>(null),
    [error, setError] = useState(""),
    [answerError, setAnswerError] = useState(""),
    [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<
    "all" | "decision" | "active" | "delivered" | "archived"
  >("all");
  function openMode(value: Mode) {
    setMode(value);
    history.replaceState(
      null,
      "",
      location.pathname +
        (value === "list"
          ? "?projects=board"
          : value === "activity"
            ? "?projects=activity"
            : "?projects"),
    );
  }
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
      all: current,
      decision: decisions,
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
    return (
      <ProjectCard
        key={p.id}
        project={p}
        onOpen={onOpen}
        showStatus={p.status === "waiting" || p.status === "interrupted"}
      />
    );
  }

  return (
    <main className="project-dashboard" aria-labelledby="projects-heading">
      <div className="project-body">
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
                  ["home", "概要"],
                  ["list", "掲示板"],
                  ["activity", "活動履歴"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={mode === value}
                  onClick={() => openMode(value)}
                >
                  {label}
                </button>
              ))}
            </nav>
            {mode === "home" && (
              <>
                {decisions.length > 0 && (
                  <section
                    className="work-decisions"
                    aria-labelledby="decisions-heading"
                  >
                    <h2 id="decisions-heading">
                      <Icon name="chat" />
                      回答待ち <span>{decisions.length}</span>
                    </h2>
                    {decisions.map((p) => (
                      <article className="decision-request" key={p.id}>
                        <button
                          className="project-link"
                          onClick={() => onOpen(p.id)}
                        >
                          {p.title}
                          <Icon name="right" />
                        </button>
                        <h3>{p.question!.question}</h3>
                        <ProjectAnswer
                          key={p.question!.entryId}
                          question={p.question!}
                          busy={!!busy}
                          onAnswer={(value) => void decide(p, value)}
                        />
                        {p.summary ||
                        (p.assessment &&
                          "sources" in p.assessment &&
                          p.assessment.sources?.length) ? (
                          <details className="decision-context">
                            <summary>背景</summary>
                            {p.summary && <p>{p.summary}</p>}
                            {p.assessment &&
                              "sources" in p.assessment &&
                              p.assessment.sources?.map(({ label, quote }) => (
                                <blockquote className="work-source" key={quote}>
                                  <strong>{label}</strong>
                                  {quote}
                                </blockquote>
                              ))}
                          </details>
                        ) : null}
                      </article>
                    ))}
                  </section>
                )}
                {current.length === 0 ? (
                  <section className="work-blank">
                    <Icon name="chat" />
                    <h2>案件はまだありません</h2>
                  </section>
                ) : (
                  <div className="work-columns">
                    <section
                      aria-labelledby="work-running-heading"
                      className="work-column"
                    >
                      <h2 id="work-running-heading">
                        <Icon name="fork" />
                        進行中 <span>{working.length}</span>
                      </h2>
                      {working.length ? (
                        working.map(card)
                      ) : (
                        <p className="work-empty">進行中の案件はありません</p>
                      )}
                      {stopped.length > 0 && (
                        <section className="work-stopped">
                          <h2>
                            要確認 <span>{stopped.length}</span>
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
                        成果物 <span>{groups.delivered.length}</span>
                      </h2>
                      {groups.delivered.length ? (
                        groups.delivered.slice(0, 4).map(card)
                      ) : (
                        <p className="work-empty">まだ成果物はありません</p>
                      )}
                      {groups.delivered.length > 4 && (
                        <button
                          className="btn-text theme-primary"
                          onClick={() => {
                            setFilter("delivered");
                            openMode("list");
                          }}
                        >
                          すべての成果物
                        </button>
                      )}
                    </section>
                  </div>
                )}
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
              <section aria-label="案件掲示板">
                <div
                  className="portfolio-filter"
                  role="group"
                  aria-label="表示する案件"
                >
                  {(
                    [
                      "all",
                      "decision",
                      "active",
                      "delivered",
                      "archived",
                    ] as const
                  ).map((value, i) => (
                    <button
                      key={value}
                      aria-pressed={filter === value}
                      onClick={() => setFilter(value)}
                    >
                      {
                        ["すべて", "回答待ち", "対応中", "完了", "アーカイブ"][
                          i
                        ]
                      }{" "}
                      <span>{groups[value].length}</span>
                    </button>
                  ))}
                </div>
                {visible.length ? (
                  <TopicBoard rows={visible} onOpen={onOpen} />
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
