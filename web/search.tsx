import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api.js";
import { Icon } from "./icons.js";

type Results = {
  matches: { entryId: number; role: string; text: string }[];
  cursor: unknown;
};
export function ConversationSearch({
  id,
  onClose,
  onSelect,
}: {
  id: string;
  onClose: () => void;
  onSelect: (entryId: number) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results>({
    matches: [],
    cursor: null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const request = useRef(0);
  const heading = useId();
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const current = ++request.current;
    setResults({ matches: [], cursor: null });
    setError("");
    if (!query.trim()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      void api<Results>(
        `/api/conversations/${id}/search?q=${encodeURIComponent(query.trim())}`,
      )
        .then((next) => {
          if (request.current === current) setResults(next);
        })
        .catch(() => {
          if (request.current === current) setError("検索できませんでした");
        })
        .finally(() => {
          if (request.current === current) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      request.current++;
    };
  }, [id, query, version]);
  async function more() {
    const current = request.current;
    setLoading(true);
    try {
      const cursor = btoa(JSON.stringify(results.cursor))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      const next = await api<Results>(
        `/api/conversations/${id}/search?q=${encodeURIComponent(query.trim())}&cursor=${encodeURIComponent(cursor)}`,
      );
      if (request.current === current)
        setResults((old) => ({
          matches: [...old.matches, ...next.matches],
          cursor: next.cursor,
        }));
    } catch {
      if (request.current === current) setError("検索できませんでした");
    } finally {
      if (request.current === current) setLoading(false);
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="session-dialog search-dialog"
      aria-labelledby={heading}
      onClose={onClose}
    >
      <header>
        <h2 id={heading}>
          <Icon name="search" />
          会話内を検索
        </h2>
        <button
          className="btn-text theme-secondary icon-button"
          aria-label="検索を閉じる"
          title="閉じる"
          onClick={() => dialog.current?.close()}
        >
          <Icon name="close" />
        </button>
      </header>
      <input
        className="form-control"
        type="search"
        aria-label="会話内を検索"
        value={query}
        maxLength={200}
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="search-results" aria-busy={loading}>
        {results.matches.map((match) => (
          <button
            key={`${match.entryId}-${match.role}`}
            className="search-result"
            onClick={async () => {
              setLoading(true);
              setError("");
              try {
                await onSelect(match.entryId);
                dialog.current?.close();
              } catch {
                setError("該当する履歴を読み込めませんでした");
              } finally {
                setLoading(false);
              }
            }}
            disabled={loading}
          >
            <Icon name={match.role === "user" ? "chat" : "agent"} />
            <span>{match.text}</span>
          </button>
        ))}
        {loading && (
          <span className="search-status" role="status">
            検索中…
          </span>
        )}
        {!loading && query.trim() && !results.matches.length && (
          <p className="fg-2">一致するメッセージはありません</p>
        )}
        {error && (
          <div role="alert">
            <p>{error}</p>
            <button
              className="btn-outline theme-secondary btn-sm"
              onClick={() => setVersion((value) => value + 1)}
            >
              再試行
            </button>
          </div>
        )}
        {!!results.cursor && (
          <button
            className="btn-text theme-secondary btn-sm"
            disabled={loading}
            onClick={() => void more()}
          >
            さらに検索
          </button>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
