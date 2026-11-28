import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { Icon } from "./icons.js";
import { Post, kindLabel } from "./project-timeline.js";
import { DeliveryBody, ProjectAnswer } from "./project-response.js";
import type { ProjectPost, TimelinePage } from "../src/project-timeline.js";
import type { WorkspaceThread, WorkspaceDocument } from "../src/workspace.js";
import type { ReactNode } from "react";

const stamp = new Intl.DateTimeFormat("ja-JP", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
export function postTime(at: number) {
  return <time dateTime={new Date(at).toISOString()}>{stamp.format(at)}</time>;
}
export function unread(t: WorkspaceThread) {
  return !!t.notice && t.notice.id > t.readThrough;
}
function OriginalPost({
  session,
  id,
  onRead,
  showBody,
  children,
}: {
  session: string;
  id: number;
  onRead?: (id: number) => void;
  showBody?: boolean;
  children?: (post: ProjectPost) => ReactNode;
}) {
  const [post, setPost] = useState<ProjectPost>(),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const read = useRef(onRead);
  read.current = onRead;
  useEffect(() => {
    const abort = new AbortController();
    setError("");
    void api<TimelinePage>(
      `/api/conversations/${session}/timeline?before=${id + 1}&limit=1`,
      "GET",
      undefined,
      abort.signal,
    )
      .then((page) => {
        const found = page.posts[0];
        if (found?.id !== id) throw new Error("投稿が見つかりません");
        if (!abort.signal.aborted) {
          setPost(found);
          read.current?.(found.id);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(
            e instanceof Error ? e.message : "投稿を取得できませんでした",
          );
      });
    return () => abort.abort();
  }, [session, id, retry]);
  if (showBody && post?.deliverable)
    return (
      <DeliveryBody
        session={session}
        body={post.deliverable}
        evidence={post.detail}
      />
    );
  return post ? (
    <Post session={session} post={post}>
      {children?.(post)}
    </Post>
  ) : error ? (
    <p role="alert">
      {error}{" "}
      <button className="project-link" onClick={() => setRetry((v) => v + 1)}>
        再読み込み
      </button>
    </p>
  ) : (
    <p role="status">投稿を読み込み中…</p>
  );
}
function SearchField({
  label,
  value,
  change,
}: {
  label: string;
  value: string;
  change: (s: string) => void;
}) {
  return (
    <label className="portal-search">
      <Icon name="search" />
      <input
        type="search"
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(e) => change(e.target.value)}
      />
    </label>
  );
}
type MailHandlers = {
  open: (id: string) => void;
  answer: (row: WorkspaceThread, option: number | string) => void;
  busy: boolean;
  mark: (session: string, id: number) => void;
};
export function Inbox({
  initial,
  threads,
  open,
  answer,
  busy,
  mark,
}: MailHandlers & { initial?: WorkspaceThread; threads: WorkspaceThread[] }) {
  const [filter, setFilter] = useState<"all" | "unread" | "decision">("all"),
    [selection, setSelection] = useState<
      { session: string; postId?: number; questionId?: number } | undefined
    >(
      initial
        ? {
            session: initial.id,
            postId: initial.notice?.id,
            questionId: initial.question?.entryId,
          }
        : undefined,
    ),
    [query, setQuery] = useState("");
  const mail = threads
    .filter((t) => !t.archived && (t.notice || t.question))
    .sort(
      (a, b) => (b.notice?.at ?? b.updatedAt) - (a.notice?.at ?? a.updatedAt),
    );
  const group = {
    all: mail,
    unread: mail.filter(unread),
    decision: mail.filter((t) => t.status === "decision"),
  };
  const text = query.trim().toLocaleLowerCase();
  const visible = group[filter].filter((t) =>
    [
      t.title,
      t.notice?.text,
      t.question?.question,
      t.notice?.name,
      t.notice?.model,
    ].some((v) => v?.toLocaleLowerCase().includes(text)),
  );
  const selected = mail.find((t) => t.id === selection?.session);
  const [limit, setLimit] = useState(30);
  const choices =
    selected?.question &&
    selected.status === "decision" &&
    selection?.questionId === selected.question.entryId ? (
      <ProjectAnswer
        key={selected.question.entryId}
        question={selected.question}
        busy={busy}
        onAnswer={(v) => answer(selected, v)}
      />
    ) : null;
  return (
    <section className="portal-inbox" aria-label="受信箱の報告">
      <div className="portal-tools">
        <div
          className="portfolio-filter"
          role="group"
          aria-label="受信箱の表示"
        >
          {(["all", "unread", "decision"] as const).map((key, i) => (
            <button
              key={key}
              aria-pressed={filter === key}
              onClick={() => {
                setFilter(key);
                setSelection(undefined);
                setLimit(30);
              }}
            >
              {["すべて", "未読", "回答待ち"][i]}{" "}
              <span>{group[key].length}</span>
            </button>
          ))}
        </div>
        <SearchField
          label="受信箱を検索"
          value={query}
          change={(v) => {
            setQuery(v);
            setLimit(30);
            setSelection(undefined);
          }}
        />
      </div>
      <div className="mail-layout">
        <div className="mail-list" aria-label="受信した報告">
          {visible.slice(0, limit).map((t) => (
            <button
              type="button"
              key={t.id}
              className="mail-row"
              aria-pressed={t.id === selected?.id}
              onClick={() =>
                setSelection({
                  session: t.id,
                  postId: t.notice?.id,
                  questionId: t.question?.entryId,
                })
              }
            >
              <span
                className={"mail-dot" + (unread(t) ? " is-unread" : "")}
                aria-label={unread(t) ? "未読" : "既読"}
              />
              <span className="mail-row-body">
                <span className="mail-meta">
                  {t.status === "decision"
                    ? "回答待ち"
                    : t.notice
                      ? kindLabel[t.notice.kind]
                      : "質問"}
                  <span>{postTime(t.notice?.at ?? t.updatedAt)}</span>
                </span>
                <strong>{t.title}</strong>
                <span className="mail-excerpt">
                  {t.question?.question || t.notice?.text}
                </span>
              </span>
            </button>
          ))}
          {!visible.length && (
            <p className="portal-empty">
              {text
                ? "一致する報告はありません"
                : filter === "unread"
                  ? "未読の報告はありません"
                  : filter === "decision"
                    ? "回答待ちの質問はありません"
                    : "報告はまだありません"}
            </p>
          )}
          {visible.length > limit && (
            <button
              className="portal-more"
              onClick={() => setLimit((n) => n + 30)}
            >
              さらに表示
            </button>
          )}
        </div>
        <section className="mail-reader" aria-label="報告の本文">
          {selected && selection ? (
            <>
              <header>
                <h2>{selected.title}</h2>
                <button
                  className="portal-link"
                  onClick={() => open(selected.id)}
                >
                  スレッドを開く <Icon name="right" />
                </button>
              </header>
              {selection.postId ? (
                <OriginalPost
                  key={selected.id + ":" + selection.postId}
                  session={selected.id}
                  id={selection.postId}
                  onRead={(id) => {
                    if (id > selected.readThrough) mark(selected.id, id);
                  }}
                >
                  {(post) =>
                    post.kind === "question" &&
                    post.questionId === selected.question?.entryId
                      ? choices
                      : null
                  }
                </OriginalPost>
              ) : (
                <>
                  <p>{selected.question?.question}</p>
                  {choices}
                </>
              )}
            </>
          ) : (
            <div className="reader-idle">
              <Icon name="inbox" />
              <p>一覧から報告を選択</p>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
export function Documents({
  items,
  open,
  mark,
}: {
  items: WorkspaceDocument[];
  mark: (session: string, id: number) => void;
  open: (id: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [kind, setKind] = useState("すべて"),
    [expanded, setExpanded] = useState(""),
    [limit, setLimit] = useState(30);
  const type = (d: WorkspaceDocument) =>
    d.file ? "パッチ" : d.written ? "文書" : "完了報告";
  const text = query.trim().toLocaleLowerCase();
  const visible = items.filter(
    (d) =>
      (kind === "すべて" || kind === type(d)) &&
      [d.title, d.text, d.name, d.model, d.file].some((v) =>
        v?.toLocaleLowerCase().includes(text),
      ),
  );
  return (
    <section className="filing-cabinet" aria-label="納品物一覧">
      <div className="portal-tools">
        <div
          className="portfolio-filter"
          role="group"
          aria-label="成果物の種類"
        >
          {["すべて", "文書", "パッチ", "完了報告"].map((k) => (
            <button
              key={k}
              aria-pressed={k === kind}
              onClick={() => {
                setKind(k);
                setLimit(30);
              }}
            >
              {k}
            </button>
          ))}
        </div>
        <SearchField
          label="成果物を検索"
          value={query}
          change={(v) => {
            setQuery(v);
            setLimit(30);
          }}
        />
      </div>
      {visible.slice(0, limit).map((d) => {
        const key = d.session + ":" + d.id;
        return (
          <article className="file-row" key={key}>
            <button
              type="button"
              className="file-subject"
              aria-expanded={key === expanded}
              onClick={() => setExpanded(key === expanded ? "" : key)}
            >
              <span className="module-icon">
                <Icon name={d.file ? "diff" : "file"} />
              </span>
              <span className="file-title">
                <small>
                  {type(d)} · {d.title}
                  {d.archived ? " · アーカイブ" : ""}
                </small>
                <strong>{d.text}</strong>
              </span>
              <span className="file-date">{postTime(d.at)}</span>
              <Icon name="chevron" />
            </button>
            {key === expanded && (
              <div className="file-preview">
                <OriginalPost
                  key={key}
                  session={d.session}
                  showBody
                  id={d.id}
                  onRead={(id) => mark(d.session, id)}
                />
                <button className="portal-link" onClick={() => open(d.session)}>
                  元のスレッドを開く <Icon name="right" />
                </button>
              </div>
            )}
          </article>
        );
      })}
      {!visible.length && (
        <p className="portal-empty">
          {items.length
            ? "一致する成果物はありません"
            : "納品された成果物はまだありません"}
        </p>
      )}
      {visible.length > limit && (
        <button className="portal-more" onClick={() => setLimit((n) => n + 30)}>
          さらに表示
        </button>
      )}
    </section>
  );
}
