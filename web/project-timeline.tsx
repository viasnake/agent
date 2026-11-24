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
import { api } from "./api.js";
import { Icon } from "./icons.js";

const kindLabel = {
  directive: "指示",
  assignment: "分担",
  start: "着手",
  progress: "進捗報告",
  report: "担当報告",
  passed: "テスト成功",
  failed: "テスト失敗",
  artifact: "成果物",
  review: "照合開始",
  revision: "差し戻し",
  question: "判断依頼",
  decision: "回答",
  delivery: "完了報告",
  interrupted: "中断",
  resume: "再開",
};
const actors = {
  user: "あなた",
  lead: "責任者",
  member: "担当",
  reviewer: "照合担当",
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
  return (
    <article
      className={"timeline-post post-" + post.kind}
      data-post-id={post.id}
    >
      <span className={"post-avatar actor-" + post.actor} aria-hidden="true">
        {post.actor === "member" ? (
          Array.from(name)[0]
        ) : (
          <Icon
            name={
              post.actor === "user"
                ? "chat"
                : post.actor === "reviewer"
                  ? "check"
                  : post.actor === "system"
                    ? "settings"
                    : "agent"
            }
          />
        )}
      </span>
      <div className="post-main">
        <header>
          <strong>{name}</strong>
          <span className="post-kind">{kindLabel[post.kind]}</span>
          <time
            dateTime={new Date(post.at).toISOString()}
            title={new Date(post.at).toLocaleString("ja-JP")}
          >
            {time.format(post.at)}
          </time>
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
        {post.detail && !post.deliverable && (
          <details className="post-details">
            <summary>
              {post.kind === "delivery"
                ? "完了の根拠"
                : post.kind === "passed" || post.kind === "failed"
                  ? "検証コマンドと出力"
                  : post.kind === "question"
                    ? "提示した選択肢"
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
            採用したパッチを保存
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
    return <p className="project-empty">新しい報告はまだありません。</p>;
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
  session,
  latest,
  question,
  disabled,
  onChoice,
  onHistory,
  visible,
  active,
}: {
  session: string;
  latest: TimelinePage;
  question?: PendingQuestion;
  disabled: boolean;
  onChoice: (id: number, index: number | string) => Promise<void>;
  onHistory: () => void;
  visible: boolean;
  active: boolean;
}) {
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
      <div
        className="timeline-viewport"
        ref={viewport}
        aria-label="案件のタイムライン"
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
              <p>この案件で新たに行われた指示や報告がここに並びます。</p>
              <button className="btn-text theme-secondary" onClick={onHistory}>
                これまでの会話を読む
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
                  {busy ? "読み込み中…" : "以前の投稿を読む"}
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
          新しい報告へ
        </button>
      )}
    </div>
  );
}
