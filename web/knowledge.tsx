import { useEffect, useState } from "react";
import { api, requestId, forget } from "./api.js";
import type { KnowledgeNote } from "../src/knowledge.js";
import type { MemorySource } from "./memory.js";
import { useNotify } from "./notifications.js";

export function KnowledgeNotes({
  onDirtyChange,
  onSelect,
}: {
  onDirtyChange: (dirty: boolean) => void;
  onSelect: (source: MemorySource) => Promise<void>;
}) {
  const [notes, setNotes] = useState<Omit<KnowledgeNote, "body">[]>([]);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const [draft, setDraft] = useState<KnowledgeNote | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const notify = useNotify();
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => {
    let current = true;
    void api<{ notes: Omit<KnowledgeNote, "body">[]; next: number | null }>(
      `/api/knowledge?query=${encodeURIComponent(query)}&offset=${offset}`,
    )
      .then((value) => {
        if (current) {
          setNotes(value.notes);
          setNext(value.next);
        }
      })
      .catch((e: Error) => {
        if (current) setError(e.message);
      });
    return () => {
      current = false;
    };
  }, [query, offset, version]);
  async function open(id?: string) {
    if (dirty && !confirm("編集中の記憶を破棄しますか？")) return;
    try {
      setDraft(
        id
          ? await api<KnowledgeNote>(`/api/knowledge/${id}`)
          : {
              id: "",
              title: "",
              body: "",
              revision: 0,
              sources: [],
              expired: false,
              updatedAt: 0,
            },
      );
      setDirty(false);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const change = {
        ...(draft.id ? { id: draft.id } : {}),
        revision: draft.revision,
        title: draft.title,
        body: draft.body,
        expired: draft.expired,
      };
      const saved = await api<KnowledgeNote>("/api/knowledge", "POST", {
        ...change,
        requestId: await requestId("knowledge", change),
      });
      forget("knowledge");
      setDraft(saved);
      setDirty(false);
      setVersion((v) => v + 1);
      notify("記憶を保存しました");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mb-4" aria-label="アシスタントの記憶">
      <div className="d-flex align-items-center gap-2 mb-2">
        <h2 className="h6 mb-0">アシスタントの記憶</h2>
        <button
          className="btn-outline theme-secondary btn-sm"
          onClick={() => void open()}
        >
          記憶を追加
        </button>
      </div>
      <input
        className="form-control mb-2"
        type="search"
        aria-label="記憶の本文を検索"
        placeholder="本文を検索"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOffset(0);
        }}
      />
      {error && (
        <div role="alert" className="text-danger">
          {error}
        </div>
      )}
      <div className="d-flex flex-wrap gap-2 mb-2">
        {notes.map((note) => (
          <button
            key={note.id}
            className="btn-text theme-primary btn-sm"
            onClick={() => void open(note.id)}
          >
            {note.title}
            {note.expired ? " · 失効" : ""}
          </button>
        ))}
      </div>
      {(offset > 0 || next !== null) && (
        <div className="d-flex gap-2">
          <button
            className="btn-text theme-secondary btn-sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            前へ
          </button>
          <button
            className="btn-text theme-secondary btn-sm"
            disabled={next === null}
            onClick={() => setOffset(next!)}
          >
            次へ
          </button>
        </div>
      )}
      {draft && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label className="form-label">
            題名
            <input
              className="form-control"
              aria-label="題名"
              required
              maxLength={160}
              value={draft.title}
              onChange={(e) => {
                setDraft({ ...draft, title: e.target.value });
                setDirty(true);
              }}
            />
          </label>
          <label className="form-label d-block">
            Markdown
            <textarea
              className="form-control"
              aria-label="Markdown"
              rows={12}
              maxLength={32000}
              value={draft.body}
              onChange={(e) => {
                setDraft({ ...draft, body: e.target.value });
                setDirty(true);
              }}
            />
          </label>
          <label className="form-check">
            <input
              className="form-check-input"
              type="checkbox"
              checked={draft.expired}
              onChange={(e) => {
                setDraft({ ...draft, expired: e.target.checked });
                setDirty(true);
              }}
            />
            失効
          </label>
          <div className="d-flex flex-wrap gap-2 my-2">
            {draft.sources.map((source, i) => (
              <button
                key={i}
                type="button"
                className="btn-text theme-primary btn-sm"
                onClick={() => void onSelect(source)}
              >
                出典 {i + 1}
              </button>
            ))}
          </div>
          <div className="d-flex gap-2">
            <button
              className="btn-solid theme-primary btn-sm"
              disabled={!dirty || busy}
            >
              記憶を保存
            </button>
            <button
              type="button"
              className="btn-text theme-secondary btn-sm"
              disabled={busy}
              onClick={() => {
                if (!dirty || confirm("編集中の記憶を破棄しますか？")) {
                  setDraft(null);
                  setDirty(false);
                }
              }}
            >
              閉じる
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
