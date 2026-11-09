import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, requestId, forget } from "./api.js";
import type { MemoryNote, HistoryResults } from "./api.js";
import { Icon } from "./icons.js";

export type MemoryPanel = {
  tab: "notes" | "search" | "daily";
  text?: string;
  source?: MemoryNote["source"];
};
export function MemoryDialog({
  initial,
  onClose,
  onSelect,
}: {
  initial: MemoryPanel;
  onClose: () => void;
  onSelect: (source: NonNullable<MemoryNote["source"]>) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [tab, setTab] = useState(initial.tab);
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [text, setText] = useState(initial.text?.slice(0, 1000) ?? "");
  const [editing, setEditing] = useState<MemoryNote | null>(null);
  const [creating, setCreating] = useState(initial.text !== undefined);
  const [source, setSource] = useState(initial.source);
  const [query, setQuery] = useState("");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [date, setDate] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  });
  const [results, setResults] = useState<HistoryResults>({
    matches: [],
    cursor: null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const searchVersion = useRef(0);
  const currentSearch = useRef("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      searchVersion.current++;
    };
  }, []);
  useEffect(() => {
    const current = ++searchVersion.current;
    setResults({ matches: [], cursor: null });
    setError("");
    if (
      tab !== "notes" &&
      ((tab === "search" && !query.trim()) || (tab === "daily" && !date))
    ) {
      setBusy(false);
      return;
    }
    setBusy(true);
    const params = new URLSearchParams({ timezone });
    if (tab === "search") params.set("query", query.trim());
    if (tab === "daily") params.set("date", date);
    currentSearch.current = `/api/history?${params}`;
    const timer = setTimeout(
      () => {
        const read =
          tab === "notes"
            ? api<{ memories: MemoryNote[] }>("/api/memories").then((value) => {
                if (current === searchVersion.current) setNotes(value.memories);
              })
            : api<HistoryResults>(currentSearch.current).then((value) => {
                if (current === searchVersion.current) setResults(value);
              });
        void read
          .catch((error: Error) => {
            if (current === searchVersion.current) setError(error.message);
          })
          .finally(() => {
            if (current === searchVersion.current) setBusy(false);
          });
      },
      tab === "search" ? 200 : 0,
    );
    return () => {
      clearTimeout(timer);
      searchVersion.current++;
    };
  }, [tab, query, date, timezone, version]);

  async function action(run: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await run();
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : "操作できませんでした");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function openSource(source: NonNullable<MemoryNote["source"]>) {
    if (await action(() => onSelect(source))) dialog.current?.close();
  }
  const title =
    tab === "notes"
      ? "記憶"
      : tab === "search"
        ? "セッション横断検索"
        : "日次レポート";
  return createPortal(
    <dialog
      ref={dialog}
      className="session-dialog memory-dialog"
      aria-labelledby={heading}
      onClose={onClose}
    >
      <header>
        <h2 id={heading}>
          <Icon
            name={
              tab === "notes"
                ? "memory"
                : tab === "daily"
                  ? "calendar"
                  : "search"
            }
          />
          {title}
        </h2>
        <button
          className="btn-text theme-secondary icon-button"
          aria-label="記憶パネルを閉じる"
          title="閉じる"
          onClick={() => dialog.current?.close()}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="memory-tabs" aria-label="記憶と履歴">
        {(
          [
            ["notes", "memory", "記憶"],
            ["search", "search", "検索"],
            ["daily", "calendar", "日報"],
          ] as const
        ).map(([key, icon, label]) => (
          <button
            key={key}
            type="button"
            className="btn-text theme-secondary"
            aria-pressed={tab === key}
            onClick={() => {
              setTab(key);
              setDeleteId(null);
            }}
          >
            <Icon name={icon} />
            {label}
          </button>
        ))}
      </div>
      {tab === "notes" ? (
        <>
          {creating || editing ? (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy || !text.trim()) return;
                const saved = await action(async () => {
                  if (editing)
                    await api(`/api/memories/${editing.id}`, "PATCH", {
                      text: text.trim(),
                      revision: editing.revision,
                    });
                  else {
                    const body = {
                      text: text.trim(),
                      ...(source ? { source } : {}),
                    };
                    await api("/api/memories", "POST", {
                      ...body,
                      requestId: await requestId("memory", body),
                    });
                    forget("memory");
                  }
                });
                if (saved) {
                  setCreating(false);
                  setEditing(null);
                  setText("");
                  setVersion((value) => value + 1);
                }
              }}
            >
              <textarea
                className="form-control"
                aria-label="記憶の内容"
                maxLength={1000}
                rows={4}
                value={text}
                disabled={busy}
                autoFocus
                onChange={(event) => setText(event.target.value)}
              />
              <footer>
                <button
                  type="button"
                  className="btn-text theme-secondary"
                  disabled={busy}
                  onClick={() => {
                    setCreating(false);
                    setEditing(null);
                  }}
                >
                  キャンセル
                </button>
                <button
                  className="btn-solid theme-primary"
                  disabled={busy || !text.trim()}
                >
                  <Icon name="check" />
                  保存
                </button>
              </footer>
            </form>
          ) : (
            <button
              className="btn-outline theme-secondary btn-sm"
              onClick={() => {
                setCreating(true);
                setText("");
                setSource(undefined);
              }}
            >
              <Icon name="plus" />
              記憶を追加
            </button>
          )}
          <div className="memory-notes" aria-busy={busy}>
            {notes.map((note) => (
              <article key={note.id} className="memory-note">
                <p>{note.text}</p>
                <footer>
                  {note.source && (
                    <button
                      className="btn-text theme-secondary btn-sm"
                      disabled={busy}
                      onClick={() => void openSource(note.source!)}
                    >
                      <Icon name="chat" />
                      出典
                    </button>
                  )}
                  <time
                    className="small fg-2"
                    dateTime={new Date(note.updatedAt).toISOString()}
                  >
                    {new Date(note.updatedAt).toLocaleDateString("ja-JP")}
                  </time>
                  <button
                    className="btn-text theme-secondary icon-button"
                    aria-label="記憶を編集"
                    title="編集"
                    disabled={busy}
                    onClick={() => {
                      setEditing(note);
                      setText(note.text);
                      setDeleteId(null);
                    }}
                  >
                    <Icon name="edit" />
                  </button>
                  <button
                    className={`btn-text theme-${deleteId === note.id ? "danger" : "secondary"} icon-button`}
                    aria-label={
                      deleteId === note.id ? "記憶の削除を確定" : "記憶を削除"
                    }
                    title={deleteId === note.id ? "削除を確定" : "削除"}
                    disabled={busy}
                    onClick={async () => {
                      if (deleteId !== note.id) {
                        setDeleteId(note.id);
                        return;
                      }
                      if (
                        await action(() =>
                          api(`/api/memories/${note.id}`, "DELETE", {}),
                        )
                      ) {
                        setDeleteId(null);
                        setVersion((value) => value + 1);
                      }
                    }}
                  >
                    <Icon name={deleteId === note.id ? "check" : "trash"} />
                  </button>
                </footer>
              </article>
            ))}
            {!notes.length && !busy && <p className="fg-2">記憶はありません</p>}
          </div>
        </>
      ) : (
        <>
          {tab === "search" ? (
            <input
              className="form-control"
              type="search"
              aria-label="全セッションの会話を検索"
              placeholder="全セッションの会話を検索"
              value={query}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : (
            <label className="memory-date">
              <input
                className="form-control"
                type="date"
                aria-label="レポートの日付"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
              <span className="small fg-2">{timezone}</span>
            </label>
          )}
          <div className="search-results" aria-busy={busy}>
            {[...results.matches]
              .sort((a, b) => b.timestamp - a.timestamp)
              .map((match) => (
                <button
                  key={`${match.sessionId}-${match.entryId}`}
                  className="search-result memory-result"
                  disabled={busy}
                  onClick={() => void openSource(match)}
                >
                  <Icon name={match.role === "user" ? "chat" : "agent"} />
                  <span>
                    <strong>{match.title}</strong>
                    <time>
                      {new Date(match.timestamp).toLocaleString("ja-JP")}
                    </time>
                    <span>{match.text}</span>
                  </span>
                </button>
              ))}
            {!busy &&
              !results.cursor &&
              !results.matches.length &&
              (tab === "daily" || query.trim()) && (
                <p className="fg-2">該当する記録はありません</p>
              )}
            {results.cursor && (
              <button
                className="btn-text theme-secondary btn-sm"
                disabled={busy}
                onClick={async () => {
                  const current = searchVersion.current;
                  await action(async () => {
                    const next = await api<HistoryResults>(
                      `${currentSearch.current}&cursor=${encodeURIComponent(results.cursor!)}`,
                    );
                    if (current === searchVersion.current)
                      setResults((old) => ({
                        matches: [...old.matches, ...next.matches],
                        cursor: next.cursor,
                      }));
                  });
                }}
              >
                さらに表示
              </button>
            )}
          </div>
        </>
      )}
      {busy && (
        <span role="status" className="small fg-2">
          読み込み中…
        </span>
      )}
      {error && (
        <div role="alert">
          <p className="fg-danger">{error}</p>
          <button
            className="btn-text theme-secondary btn-sm"
            onClick={() => setVersion((value) => value + 1)}
          >
            再読み込み
          </button>
        </div>
      )}
    </dialog>,
    document.body,
  );
}
