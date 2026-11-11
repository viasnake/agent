import { useEffect, useRef, useState } from "react";
import { api, requestId, forget } from "./api.js";
import type { MemoryNote } from "./api.js";
import { Icon } from "./icons.js";

export type MemoryDraft = { text?: string; source?: MemoryNote["source"] };
export type MemorySource = NonNullable<MemoryNote["source"]>;

export function MemoryNotes({
  initial = {},
  onSelect,
}: {
  initial?: MemoryDraft;
  onSelect: (source: MemorySource) => Promise<void>;
}) {
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [text, setText] = useState(initial.text?.slice(0, 1000) ?? "");
  const [editing, setEditing] = useState<MemoryNote | null>(null);
  const [creating, setCreating] = useState(initial.text !== undefined);
  const [source, setSource] = useState(initial.source);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const busy = loading || acting;
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const request = useRef(0);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  useEffect(() => {
    const current = ++request.current;
    setLoading(true);
    setError("");
    void api<{ memories: MemoryNote[] }>("/api/memories")
      .then((value) => {
        if (current !== request.current) return;
        setNotes(value.memories);
        // Preserve the draft while refreshing the revision for an explicit, reviewed retry.
        setEditing((previous) =>
          previous
            ? (value.memories.find((note) => note.id === previous.id) ??
              previous)
            : null,
        );
        setDeleteId(null);
      })
      .catch((error: Error) => {
        if (current === request.current) setError(error.message);
      })
      .finally(() => {
        if (current === request.current) setLoading(false);
      });
    return () => {
      request.current++;
    };
  }, [version]);
  async function action(run: () => Promise<unknown>) {
    setActing(true);
    setError("");
    try {
      await run();
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : "操作できませんでした");
      return false;
    } finally {
      setActing(false);
    }
  }

  async function openSource(source: MemorySource) {
    await action(() => onSelect(source));
  }
  return (
    <section className="memory-content" aria-label="記憶">
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
                      api(`/api/memories/${note.id}`, "DELETE", {
                        revision: note.revision,
                      }),
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
      </div>{" "}
      {busy && (
        <span role="status" className="small fg-2">
          {acting ? "処理中…" : "読み込み中…"}
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
    </section>
  );
}
