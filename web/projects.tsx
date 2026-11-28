import type {
  WorkspaceDocument,
  WorkspaceOverview,
  WorkspaceThread,
} from "../src/workspace.js";
import { Documents, Inbox, postTime, unread } from "./workspace-mail.js";
import { actors, kindLabel } from "./project-timeline.js";
import { workspaceViews, type WorkspaceView } from "./workspace-nav.js";
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
  draft: "未投稿",
  history: "履歴あり",
  answered: "返信済み",
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
      (b.lastPostedAt ?? b.updatedAt) - (a.lastPostedAt ?? a.updatedAt) ||
      b.updatedAt - a.updatedAt ||
      a.id.localeCompare(b.id),
  );
  return (
    <table className="topic-board" aria-label="スレッド一覧">
      <thead>
        <tr>
          <th scope="col">件名・最新投稿</th>
          <th scope="col">状態</th>
          <th scope="col">更新</th>
        </tr>
      </thead>
      <tbody>
        {topics.map((p) => {
          const excerpt =
            p.status === "decision"
              ? p.question?.question
              : p.status === "interrupted"
                ? p.detail
                : p.lastReport || p.summary;
          return (
            <tr key={p.id}>
              <th scope="row">
                <a
                  href={"?thread=" + encodeURIComponent(p.id)}
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
                {excerpt && excerpt !== p.title && <p>{excerpt}</p>}
              </th>
              <td>
                <StateLabel status={p.status} />
              </td>
              <td>
                {p.lastPostedAt || p.updatedAt ? (
                  <time
                    dateTime={new Date(
                      p.lastPostedAt ?? p.updatedAt,
                    ).toISOString()}
                  >
                    {updatedTime.format(p.lastPostedAt ?? p.updatedAt)}
                  </time>
                ) : (
                  "—"
                )}
                <small className="topic-total">
                  {p.postCount ? (
                    <>
                      <span className="topic-count">{p.postCount}</span> 投稿
                    </>
                  ) : null}
                </small>
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
  const note =
    p.status === "interrupted"
      ? p.detail
      : p.assessment?.verdict === "revise"
        ? p.assessment.reason
        : p.summary || (p.instruction !== p.title ? p.instruction : "");
  const updated = new Date(p.updatedAt);
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
      {(p.members.length > 0 || p.evidence || p.assessment) && (
        <ProjectTeamStatus project={p} showSummary={note !== p.summary} />
      )}
    </article>
  );
}

function ModuleHeading({
  icon,
  title,
  count,
  onOpen,
  action,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  count?: number;
  onOpen?: () => void;
  action?: string;
}) {
  return (
    <header className="module-heading">
      <h2>
        <span className="module-icon">
          <Icon name={icon} />
        </span>
        {title}{" "}
        {count !== undefined && <span className="module-count">{count}</span>}
      </h2>
      {onOpen && (
        <button className="portal-link" onClick={onOpen}>
          {action ?? "一覧へ"}
          <Icon name="right" />
        </button>
      )}
    </header>
  );
}
export function ProjectDashboard({
  mode,
  openMode,
  onOpen,
  onNew,
  onMenu,
}: {
  onOpen: (id: string) => void;
  onNew: () => void;
  onMenu: () => void;
  mode: WorkspaceView;
  openMode: (view: WorkspaceView) => void;
}) {
  const [activity, setActivity] = useState<PortfolioPost[] | null>(null);
  const [rows, setRows] = useState<WorkspaceThread[] | null>(null),
    [error, setError] = useState(""),
    [answerError, setAnswerError] = useState(""),
    [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<
    "all" | "decision" | "active" | "delivered" | "archived"
  >("all");
  const [documents, setDocuments] = useState<WorkspaceDocument[] | null>(null);
  const [boardQuery, setBoardQuery] = useState("");
  const [mailTarget, setMailTarget] = useState<WorkspaceThread>();
  const documentScope =
    mode === "documents" ? "1" : mode === "home" ? "recent" : undefined;
  const showActivity = mode === "activity";
  const alive = useRef(false),
    generation = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try {
      const result = await api<WorkspaceOverview>(
        "/api/workspace" + (documentScope ? "?documents=" + documentScope : ""),
      );
      const feed = showActivity
        ? await api<{ posts: PortfolioPost[] }>(
            "/api/project-dashboard/activity",
          )
        : undefined;
      if (alive.current && version === generation.current) {
        if (feed) setActivity(feed.posts);
        setRows(result.threads);
        setDocuments(result.documents);
        setError("");
      }
    } catch (e) {
      if (alive.current && version === generation.current)
        setError(e instanceof Error ? e.message : "進捗を取得できませんでした");
    }
  }, [showActivity, documentScope]);
  useEffect(() => {
    alive.current = true;
    setDocuments(null);
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
  async function mark(session: string, id: number) {
    if ((rows?.find((t) => t.id === session)?.readThrough ?? 0) >= id) return;
    try {
      const result = await api<{ readThrough: number }>(
        `/api/conversations/${session}/read-through`,
        "POST",
        { postId: id },
      );
      if (alive.current) {
        generation.current++;
        setRows(
          (current) =>
            current?.map((t) =>
              t.id === session
                ? {
                    ...t,
                    readThrough: Math.max(t.readThrough, result.readThrough),
                  }
                : t,
            ) ?? null,
        );
      }
    } catch (e) {
      if (alive.current)
        setAnswerError(
          e instanceof Error ? e.message : "既読を保存できませんでした",
        );
    }
  }
  const all = rows ?? [],
    current = all.filter((p) => !p.archived),
    decisions = current.filter((p) => p.status === "decision"),
    groups = {
      all: current,
      decision: decisions,
      active: current.filter((p) => p.status === "working"),
      delivered: current.filter((p) => p.status === "delivered"),
      archived: all.filter((p) => p.archived),
    };
  const boardText = boardQuery.trim().toLocaleLowerCase();
  const visible = groups[filter].filter((t) =>
    [
      t.title,
      t.summary,
      t.lastReport,
      t.question?.question,
      ...t.members.map((m) => m.role),
    ].some((v) => v?.toLocaleLowerCase().includes(boardText)),
  );
  const reports = current
    .filter((t) => t.notice && t.status !== "decision")
    .sort((a, b) => b.notice!.at - a.notice!.at);
  const unreadCount = current.filter(unread).length;
  const working = groups.active,
    stopped = current.filter(
      (p) => p.status === "interrupted" || p.status === "waiting",
    );
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
            aria-label="スレッド一覧を開く"
          >
            <Icon name="menu" />
          </button>
          <h1 id="projects-heading">{workspaceViews[mode].label}</h1>
          <button
            className="portal-compose btn-solid theme-primary"
            onClick={onNew}
          >
            <Icon name="plus" /> 依頼を書く
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
            {mode === "home" && (
              <>
                <div className="home-grid">
                  <div className="home-main">
                    <section className="home-module home-mail">
                      <ModuleHeading
                        icon="inbox"
                        title="受信箱"
                        onOpen={() => {
                          setMailTarget(undefined);
                          openMode("inbox");
                        }}
                        action="受信箱を開く"
                      />
                      <div className="home-mail-totals">
                        <span>
                          未読 <b>{unreadCount}</b>
                        </span>
                        <span>
                          回答待ち <b>{decisions.length}</b>
                        </span>
                      </div>
                      {decisions.length > 0 && (
                        <div className="work-decisions">
                          {decisions.slice(0, 2).map((p) => (
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
                                    p.assessment.sources?.map(
                                      ({ label, quote }) => (
                                        <blockquote
                                          className="work-source"
                                          key={quote}
                                        >
                                          <strong>{label}</strong>
                                          {quote}
                                        </blockquote>
                                      ),
                                    )}
                                </details>
                              ) : null}
                            </article>
                          ))}
                        </div>
                      )}
                      {reports.slice(0, 3).map((t) => (
                        <button
                          key={t.id}
                          className="home-report"
                          onClick={() => {
                            setMailTarget(t);
                            openMode("inbox");
                          }}
                        >
                          <span
                            className={
                              "mail-dot" + (unread(t) ? " is-unread" : "")
                            }
                          />
                          <span>
                            <small>
                              {kindLabel[t.notice!.kind]} ·{" "}
                              {t.notice!.name || actors[t.notice!.actor]}
                            </small>
                            <strong>{t.title}</strong>
                          </span>
                          {postTime(t.notice!.at)}
                          <Icon name="right" />
                        </button>
                      ))}
                      {!reports.length && !decisions.length && (
                        <p className="portal-empty">報告はまだありません</p>
                      )}
                    </section>
                    <section className="home-module home-board">
                      <ModuleHeading
                        icon="board"
                        title="最近のスレッド"
                        onOpen={() => {
                          setFilter("all");
                          setBoardQuery("");
                          openMode("board");
                        }}
                        action="掲示板を開く"
                      />
                      {current.length ? (
                        <TopicBoard
                          rows={[...current]
                            .sort(
                              (a, b) =>
                                (b.lastPostedAt ?? b.updatedAt) -
                                (a.lastPostedAt ?? a.updatedAt),
                            )
                            .slice(0, 6)}
                          onOpen={onOpen}
                        />
                      ) : (
                        <p className="portal-empty">スレッドはまだありません</p>
                      )}
                    </section>
                  </div>
                  <div className="home-side">
                    <section className="home-module home-work">
                      <ModuleHeading
                        icon="fork"
                        title="進行中"
                        count={working.length}
                        onOpen={() => {
                          setFilter("active");
                          setBoardQuery("");
                          openMode("board");
                        }}
                      />
                      {working.length ? (
                        working.slice(0, 4).map(card)
                      ) : (
                        <p className="portal-empty">
                          進行中のスレッドはありません
                        </p>
                      )}
                      {stopped.length > 0 && (
                        <div className="work-stopped">
                          <h3>
                            要確認 <span>{stopped.length}</span>
                          </h3>
                          {stopped.map(card)}
                        </div>
                      )}
                    </section>
                    <section className="home-module home-files">
                      <ModuleHeading
                        icon="library"
                        title="最近の納品"
                        onOpen={() => openMode("documents")}
                        action="成果物を開く"
                      />
                      {documents?.map((d) => (
                        <article
                          className="home-file"
                          key={d.session + ":" + d.id}
                        >
                          <small>
                            {d.file
                              ? "採用パッチ"
                              : d.written
                                ? "文書"
                                : "完了報告"}{" "}
                            · {postTime(d.at)}
                          </small>
                          <button
                            className="project-link"
                            onClick={() => onOpen(d.session)}
                          >
                            {d.title}
                          </button>
                          <p>{d.text}</p>
                          {d.written && (
                            <ProjectDeliverable
                              session={d.session}
                              postId={d.id}
                            />
                          )}{" "}
                          {d.file && (
                            <a
                              className="work-file"
                              href={`/api/conversations/${d.session}/download?path=${encodeURIComponent(d.file)}`}
                            >
                              パッチを保存
                            </a>
                          )}
                        </article>
                      ))}
                      {documents?.length === 0 && (
                        <p className="portal-empty">新しい納品はありません</p>
                      )}
                    </section>
                  </div>
                </div>
              </>
            )}
            {mode === "inbox" && (
              <Inbox
                initial={mailTarget}
                threads={all}
                open={onOpen}
                busy={!!busy}
                mark={mark}
                answer={decide}
              />
            )}
            {mode === "documents" && !documents && !error && (
              <p role="status">成果物を読み込み中…</p>
            )}
            {mode === "documents" && documents && (
              <Documents items={documents} open={onOpen} mark={mark} />
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
            {mode === "board" && (
              <section aria-label="掲示板">
                <div className="portal-tools">
                  <div
                    className="portfolio-filter"
                    role="group"
                    aria-label="表示するスレッド"
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
                          [
                            "すべて",
                            "回答待ち",
                            "進行中",
                            "完了",
                            "アーカイブ",
                          ][i]
                        }{" "}
                        <span>{groups[value].length}</span>
                      </button>
                    ))}
                  </div>
                  <label className="portal-search">
                    <Icon name="search" />
                    <input
                      type="search"
                      aria-label="掲示板を検索"
                      placeholder="件名・報告・担当で検索"
                      value={boardQuery}
                      onChange={(e) => setBoardQuery(e.target.value)}
                    />
                  </label>
                </div>
                {visible.length ? (
                  <TopicBoard rows={visible} onOpen={onOpen} />
                ) : (
                  <p className="work-empty">該当するスレッドはありません。</p>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
