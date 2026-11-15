import { useEffect, useRef, useState } from "react";
import { api, requestId, forget } from "./api.js";
import type { MemoryNote } from "./api.js";
import { SettingsToolbar, SettingsEmpty } from "./settings-layout.js";
import { useNotify } from "./notifications.js";
import { Icon } from "./icons.js";

export type MemoryDraft = { text?: string; source?: MemoryNote["source"] };
export type MemorySource = NonNullable<MemoryNote["source"]>;

export function MemoryNotes({
  initial = {},
  onSelect,
  onDirtyChange,
}: {
  initial?: MemoryDraft;
  onDirtyChange?: (dirty: boolean) => void;
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
  useEffect(() => {
    onDirtyChange?.(creating || !!editing);
  }, [creating, editing, onDirtyChange]);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const request = useRef(0);
  const notify = useNotify();
  const opener = useRef<HTMLButtonElement | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!busy && !creating && !editing && restoreFocus.current) {
      restoreFocus.current = false;
      (opener.current?.isConnected
        ? opener.current
        : addButton.current
      )?.focus();
    }
  }, [busy, creating, editing]);
  function closeEditor() {
    setCreating(false);
    setEditing(null);
    setText("");
    restoreFocus.current = true;
  }
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
      {!(creating || editing) && (
        <SettingsToolbar>
          <button
            ref={addButton}
            type="button"
            className="btn-outline theme-secondary"
            disabled={busy || creating || !!editing || notes.length >= 32}
            onClick={(event) => {
              opener.current = event.currentTarget;
              setCreating(true);
              setText("");
              setSource(undefined);
            }}
          >
            追加
          </button>
        </SettingsToolbar>
      )}
      {(creating || editing) && (
        <form
          className="settings-card card card-body p-5 gap-4 mb-5"
          aria-label={editing ? "記憶を編集" : "記憶を追加"}
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
              notify(editing ? "記憶を保存しました" : "記憶を追加しました");
              closeEditor();
              setVersion((value) => value + 1);
            }
          }}
        >
          <h3 className="fs-md fw-semibold m-0">
            {editing ? "記憶を編集" : "記憶を追加"}
          </h3>
          <label className="form-label d-block m-0">
            記憶の内容
            <textarea
              className="form-control mt-1"
              aria-label="記憶の内容"
              maxLength={1000}
              rows={4}
              value={text}
              disabled={busy}
              autoFocus
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <div className="d-flex align-items-center flex-wrap gap-3 border-top pt-4">
            <button
              type="submit"
              className="btn-solid theme-primary"
              disabled={busy || !text.trim()}
            >
              {editing ? "保存" : "追加"}
            </button>
            <button
              type="button"
              className="btn-text theme-secondary"
              disabled={busy}
              onClick={closeEditor}
            >
              キャンセル
            </button>
          </div>
        </form>
      )}
      <div className="memory-notes" aria-busy={busy}>
        {notes.map((note) => (
          <article
            key={note.id}
            className="settings-card memory-note card card-body p-5 gap-4 mb-5"
          >
            <p>{note.text}</p>
            <div className="d-flex align-items-center flex-wrap gap-3">
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
            </div>
            <div className="d-flex align-items-center flex-wrap gap-3 border-top pt-4">
              <button
                className="btn-text theme-secondary"
                aria-label="記憶を編集"
                title="編集"
                disabled={busy || creating || !!editing}
                onClick={(event) => {
                  opener.current = event.currentTarget;
                  setEditing(note);
                  setText(note.text);
                }}
              >
                編集
              </button>
              <button
                className="btn-text theme-danger ms-auto"
                aria-label="記憶を削除"
                disabled={busy || creating || !!editing}
                onClick={async () => {
                  if (!window.confirm("この記憶を削除しますか？")) return;
                  if (
                    await action(() =>
                      api(`/api/memories/${note.id}`, "DELETE", {
                        revision: note.revision,
                      }),
                    )
                  ) {
                    notify("記憶を削除しました");
                    opener.current = addButton.current;
                    restoreFocus.current = true;
                    setVersion((value) => value + 1);
                  }
                }}
              >
                削除
              </button>
            </div>
          </article>
        ))}
        {!notes.length && !busy && !error && (
          <SettingsEmpty>記憶はありません</SettingsEmpty>
        )}
      </div>
      {busy && (
        <span role="status" className="small fg-2">
          {acting ? "処理中…" : "読み込み中…"}
        </span>
      )}
      {error && (
        <div role="alert">
          <p className="fg-danger">{error}</p>
          <button
            type="button"
            className="btn-text theme-secondary"
            disabled={busy}
            onClick={() => setVersion((value) => value + 1)}
          >
            再読み込み
          </button>
        </div>
      )}
    </section>
  );
}
