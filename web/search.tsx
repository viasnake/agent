import { useEffect, useId, useRef, useState } from "react";
import { api } from "./api.js";
import type { HistoryResults } from "./api.js";
import type { MemorySource } from "./memory.js";
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
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results>({
    matches: [],
    cursor: null,
  });
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const request = useRef(0);
  const heading = useId();
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
  return (
    <section
      className="conversation-search"
      aria-labelledby={heading}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
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
          onClick={onClose}
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
      <div className="search-results" aria-busy={loading || selecting}>
        {results.matches.map((match) => (
          <button
            key={`${match.entryId}-${match.role}`}
            className="search-result"
            onClick={async () => {
              setSelecting(true);
              setError("");
              try {
                await onSelect(match.entryId);
              } catch {
                setError("該当する履歴を読み込めませんでした");
              } finally {
                setSelecting(false);
              }
            }}
            disabled={loading || selecting}
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
    </section>
  );
}

export function SessionSearchResults({
  query,
  onSelect,
}: {
  query: string;
  onSelect: (source: MemorySource) => Promise<void>;
}) {
  const [results, setResults] = useState<HistoryResults>({
    matches: [],
    cursor: null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const request = useRef(0);
  const path = `/api/history?query=${encodeURIComponent(query.trim())}`;
  useEffect(() => {
    const current = ++request.current;
    setResults({ matches: [], cursor: null });
    setError("");
    setLoading(true);
    const timer = setTimeout(() => {
      void api<HistoryResults>(path)
        .then((value) => {
          if (current === request.current) setResults(value);
        })
        .catch(() => {
          if (current === request.current)
            setError("会話本文を検索できませんでした");
        })
        .finally(() => {
          if (current === request.current) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      request.current++;
    };
  }, [path, version]);
  async function more() {
    const current = request.current;
    setLoading(true);
    setError("");
    try {
      const next = await api<HistoryResults>(
        `${path}&cursor=${encodeURIComponent(results.cursor!)}`,
      );
      if (current === request.current)
        setResults((old) => ({
          matches: [...old.matches, ...next.matches],
          cursor: next.cursor,
        }));
    } catch {
      if (current === request.current)
        setError("会話本文を検索できませんでした");
    } finally {
      if (current === request.current) setLoading(false);
    }
  }
  return (
    <section
      className="session-search-results"
      aria-label="会話本文の検索結果"
      aria-busy={loading}
    >
      <h2 className="sidebar-label">会話本文</h2>
      {results.matches.map((match) => (
        <button
          key={`${match.sessionId}-${match.entryId}`}
          className="search-result"
          disabled={loading}
          onClick={async () => {
            setError("");
            try {
              await onSelect(match);
            } catch {
              setError("該当する履歴を読み込めませんでした");
            }
          }}
        >
          <span>
            <strong>{match.title}</strong>
            <span>{match.text}</span>
          </span>
        </button>
      ))}
      {loading && (
        <p role="status" className="session-list-empty">
          検索中…
        </p>
      )}
      {!loading && !error && !results.matches.length && (
        <p className="session-list-empty">一致する本文はありません</p>
      )}
      {error && (
        <div role="alert" className="session-search-error">
          <p>{error}</p>
          <button
            className="btn-text theme-secondary btn-sm"
            onClick={() => setVersion((value) => value + 1)}
          >
            再試行
          </button>
        </div>
      )}
      {results.cursor && (
        <button
          className="btn-text theme-secondary btn-sm"
          disabled={loading}
          onClick={() => void more()}
        >
          さらに検索
        </button>
      )}
    </section>
  );
}
