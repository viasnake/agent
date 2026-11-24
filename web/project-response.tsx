import { api } from "./api.js";
import type { TimelinePage } from "../src/project-timeline.js";
import { useEffect, useState } from "react";
import type { PendingQuestion } from "../src/choices.js";
import { ConversationId, MarkdownText } from "./messages.js";

export function ProjectAnswer({
  question,
  busy,
  onAnswer,
}: {
  question: PendingQuestion;
  busy: boolean;
  onAnswer: (value: number | string) => void;
}) {
  const [typing, setTyping] = useState(false);
  const [answer, setAnswer] = useState("");
  return (
    <div className="project-answer">
      <div className="post-choices" role="group" aria-label={question.question}>
        {question.options.map((option, index) => (
          <button
            className="btn-outline theme-primary btn-sm"
            disabled={busy}
            key={option}
            onClick={() => onAnswer(index)}
          >
            {option}
          </button>
        ))}
        <button
          className="btn-text theme-secondary btn-sm"
          aria-expanded={typing}
          onClick={() => setTyping(!typing)}
        >
          自分の言葉で回答
        </button>
      </div>
      {typing && (
        <form
          className="project-reply-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (answer.trim() && !busy) onAnswer(answer.trim());
          }}
        >
          <textarea
            autoFocus
            rows={2}
            maxLength={2000}
            aria-label="判断依頼への回答"
            placeholder="条件や判断の理由を添える…"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <button
            className="btn-solid theme-primary btn-sm"
            disabled={busy || !answer.trim()}
          >
            回答して再開
          </button>
        </form>
      )}
    </div>
  );
}

export function ProjectDeliverable({
  session,
  text,
  postId,
}: {
  session: string;
  text?: string;
  postId?: number;
}) {
  const [open, setOpen] = useState(false),
    [loaded, setLoaded] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    if (!open || text || loaded || !postId) return;
    const abort = new AbortController();
    setError("");
    void api<TimelinePage>(
      `/api/conversations/${session}/timeline?before=${postId + 1}&limit=1`,
      "GET",
      undefined,
      abort.signal,
    )
      .then((page) => {
        const post = page.posts[0];
        if (
          post?.id !== postId ||
          post.kind !== "delivery" ||
          !post.deliverable
        )
          throw new Error("納品本文を取得できませんでした");
        if (!abort.signal.aborted) setLoaded(post.deliverable);
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(
            e instanceof Error ? e.message : "納品本文を取得できませんでした",
          );
      });
    return () => abort.abort();
  }, [open, text, loaded, session, postId]);
  return (
    <details
      className="project-deliverable"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>納品本文を読む</summary>
      {open &&
        (text || loaded ? (
          <ConversationId.Provider value={session}>
            <MarkdownText text={text || loaded} finalAnswer />
          </ConversationId.Provider>
        ) : (
          <p role={error ? "alert" : "status"}>
            {error || "本文を読み込み中…"}
          </p>
        ))}
    </details>
  );
}
