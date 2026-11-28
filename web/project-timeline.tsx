import { ProjectTeamStatus, projectRoles } from "./project-team.js";
import { ProjectAnswer, ProjectDeliverable } from "./project-response.js";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  PortfolioPost,
  ProjectPost,
  TimelinePage,
} from "../src/project-timeline.js";
import type { PendingQuestion } from "../src/choices.js";
import { api, type View } from "./api.js";
import { Icon } from "./icons.js";

const kindLabel = {
  reply: "返信",
  directive: "指示",
  assignment: "分担",
  start: "着手",
  progress: "進捗",
  report: "報告",
  passed: "テスト成功",
  failed: "テスト失敗",
  artifact: "成果物",
  review: "検証開始",
  review_error: "検証中断",
  revision: "差し戻し",
  question: "質問",
  decision: "回答",
  delivery: "納品",
  interrupted: "中断",
  resume: "再開",
};
const actors = {
  user: "あなた",
  lead: projectRoles.lead.name,
  member: "担当",
  reviewer: projectRoles.reviewer.name,
  system: "システム",
};
const time = new Intl.DateTimeFormat("ja-JP", {
  hour: "2-digit",
  minute: "2-digit",
});
const date = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
});
function Post({
  post,
  session,
  project,
  children,
}: {
  post: ProjectPost;
  session: string;
  project?: ReactNode;
  children?: ReactNode;
}) {
  const name = post.name || actors[post.actor];
  const number = !project && (
    <span className="post-number" aria-label={`投稿 ${post.id}`}>
      #{post.id}
    </span>
  );
  const timestamp = (
    <time
      dateTime={new Date(post.at).toISOString()}
      title={new Date(post.at).toLocaleString("ja-JP")}
    >
      {time.format(post.at)}
    </time>
  );
  if ((post.kind === "start" || post.kind === "review") && !project) {
    return (
      <article
        className={"timeline-post post-notice post-" + post.kind}
        data-post-id={post.id}
      >
        <details className="start-notice">
          <summary>
            <span>{name}</span>
            {post.model && <small className="post-model">{post.model}</small>}
            <span>{post.kind === "start" ? "着手" : "レビュー開始"}</span>
            {timestamp}
            {number}
            <Icon name="chevron" />
          </summary>
          <p>{post.text}</p>
        </details>
      </article>
    );
  }
  return (
    <article
      className={
        "timeline-post post-" + post.kind + (children ? " awaiting-answer" : "")
      }
      data-post-id={post.id}
    >
      <div className="post-main">
        <header>
          <strong>{name}</strong>
          {post.model && <span className="post-model">{post.model}</span>}
          <span className="post-kind">{kindLabel[post.kind]}</span>
          {timestamp}
          {number}
          {project}
        </header>
        <p>{post.text}</p>
        {post.deliverable && (
          <ProjectDeliverable
            session={session}
            text={post.deliverable}
            detail={post.detail}
          />
        )}
        {post.detail &&
          !post.deliverable &&
          !(post.kind === "question" && children) && (
            <details className="post-details">
              <summary>
                {post.kind === "delivery"
                  ? "完了の根拠"
                  : post.kind === "passed" || post.kind === "failed"
                    ? "テストログ"
                    : post.kind === "question"
                      ? "選択肢"
                      : "詳細"}
              </summary>
              <pre>{post.detail}</pre>
            </details>
          )}
        {post.file && (
          <a
            className="post-file"
            href={`/api/conversations/${session}/download?path=${encodeURIComponent(post.file)}`}
          >
            <Icon name="file" />
            パッチを保存
          </a>
        )}
        {children}
      </div>
    </article>
  );
}
export function RecentPosts({
  posts,
  onOpen,
}: {
  posts: PortfolioPost[];
  onOpen: (id: string) => void;
}) {
  if (!posts.length)
    return <p className="project-empty">報告はまだありません</p>;
  return (
    <div className="recent-posts">
      {posts.map(({ session, title, post }, i) => (
        <Fragment key={session + "-" + post.id}>
          {(!i ||
            date.format(post.at) !== date.format(posts[i - 1]!.post.at)) && (
            <div className="post-date">{date.format(post.at)}</div>
          )}
          <Post
            post={post}
            session={session}
            project={
              <button className="post-project" onClick={() => onOpen(session)}>
                {title}
                <Icon name="right" />
              </button>
            }
          />
        </Fragment>
      ))}
    </div>
  );
}
function combine(rows: ProjectPost[], added: ProjectPost[]) {
  const ids = new Set(rows.map((p) => p.id)),
    fresh = added.filter((p) => !ids.has(p.id));
  return fresh.length ? [...rows, ...fresh].sort((a, b) => a.id - b.id) : rows;
}
export function ProjectTimeline({
  project,
  onBoard,
  latest,
  question,
  disabled,
  onChoice,
  onHistory,
  visible,
  active,
}: {
  project: NonNullable<View["project"]>;
  onBoard: () => void;
  latest: TimelinePage;
  question?: PendingQuestion;
  disabled: boolean;
  onChoice: (id: number, index: number | string) => Promise<void>;
  onHistory: () => void;
  visible: boolean;
  active: boolean;
}) {
  const session = project.id;
  const revised =
    !!project.currentInstruction &&
    project.currentInstruction !== project.brief;
  const request = project.currentInstruction || project.brief;
  const [rows, setRows] = useState(latest.posts),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [newer, setNewer] = useState(false);
  const viewport = useRef<HTMLDivElement>(null),
    following = useRef(true),
    lastSeen = useRef(0),
    anchor = useRef<{ id: number; y: number } | null>(null);
  useEffect(
    () => setRows((previous) => combine(previous, latest.posts)),
    [latest],
  );
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!visible || !el) return;
    const last = rows.at(-1)?.id ?? 0;
    if (anchor.current) {
      const a = anchor.current,
        post = el.querySelector<HTMLElement>(`[data-post-id="${a.id}"]`);
      if (post) el.scrollTop += post.getBoundingClientRect().top - a.y;
      anchor.current = null;
    } else if (following.current) el.scrollTop = el.scrollHeight;
    if (following.current) {
      lastSeen.current = last;
      setNewer(false);
    } else if (last > lastSeen.current) setNewer(true);
  }, [rows, visible, question?.entryId]);
  async function earlier(before: number) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const page = await api<TimelinePage>(
        `/api/conversations/${session}/timeline?before=${before}`,
      );
      const post = viewport.current?.querySelector<HTMLElement>(
        `[data-post-id="${before}"]`,
      );
      if (post) {
        following.current = false;
        anchor.current = { id: before, y: post.getBoundingClientRect().top };
      }
      setRows((previous) => combine(previous, page.posts));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "以前の投稿を取得できませんでした",
      );
    } finally {
      setBusy(false);
    }
  }
  const choices = question && (
    <ProjectAnswer
      key={question.entryId}
      question={question}
      busy={disabled}
      onAnswer={(value) => void onChoice(question.entryId, value)}
    />
  );
  return (
    <div className="timeline-pane" hidden={!visible}>
      <section className="topic-intro" aria-label="スレッドの概要">
        <div className="topic-intro-inner">
          <div className="topic-path">
            <button
              className="btn-text theme-secondary btn-sm"
              onClick={onBoard}
            >
              <Icon name="left" />
              掲示板
            </button>
            <span>{project.postCount} 投稿</span>
          </div>
          {request && (
            <details className="topic-request">
              <summary>
                <b>{revised ? "現在の依頼" : "最初の依頼"}</b>
                <span>{request}</span>
                <Icon name="chevron" />
              </summary>
              <p>{request}</p>
              {revised && project.brief && (
                <>
                  <b>最初の依頼</b>
                  <p>{project.brief}</p>
                </>
              )}
            </details>
          )}
          <ProjectTeamStatus
            project={project}
            includeLead
            showSummary={false}
          />
          {project.status === "delivered" && (
            <div className="topic-result">
              <strong>結論</strong>
              {project.summary && <p>{project.summary}</p>}
              {project.deliveryPost && (
                <ProjectDeliverable
                  key={project.deliveryPost}
                  session={session}
                  postId={project.deliveryPost}
                />
              )}
            </div>
          )}
        </div>
      </section>
      <div
        className="timeline-viewport"
        ref={viewport}
        aria-label="スレッドの投稿"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current =
            el.scrollHeight - el.clientHeight - el.scrollTop < 36;
          if (following.current) {
            lastSeen.current = rows.at(-1)?.id ?? 0;
            setNewer(false);
          }
        }}
      >
        <div className="timeline-stream">
          {!rows.length && (
            <div className="timeline-empty">
              <p>投稿はまだありません</p>
              <button className="btn-text theme-secondary" onClick={onHistory}>
                実行履歴を開く
              </button>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          {rows.map((post, i) => (
            <Fragment key={post.id}>
              {post.id > (rows[i - 1]?.id ?? 0) + 1 && (
                <button
                  className="load-posts btn-text theme-secondary btn-sm"
                  disabled={busy}
                  onClick={() => void earlier(post.id)}
                >
                  {busy ? "読み込み中…" : "以前の投稿"}
                </button>
              )}
              {(!i ||
                date.format(post.at) !== date.format(rows[i - 1]!.at)) && (
                <div className="post-date">{date.format(post.at)}</div>
              )}
              <Post post={post} session={session}>
                {post.kind === "question" &&
                  post.questionId === question?.entryId &&
                  choices}
              </Post>
            </Fragment>
          ))}
          {question &&
            !rows.some(
              (p) => p.kind === "question" && p.questionId === question.entryId,
            ) && (
              <div className="conversation-notice">
                <strong>{question.question}</strong>
                {choices}
              </div>
            )}
          {active && (
            <div className="timeline-live" role="status">
              <span className="running-dot" />
              チームが作業中
            </div>
          )}
        </div>
      </div>
      {newer && (
        <button
          className="timeline-new btn-solid theme-primary btn-sm"
          onClick={() => {
            const el = viewport.current;
            if (el) {
              el.scrollTop = el.scrollHeight;
              following.current = true;
              lastSeen.current = rows.at(-1)?.id ?? 0;
              setNewer(false);
            }
          }}
        >
          <Icon name="down" />
          最新へ
        </button>
      )}
    </div>
  );
}
