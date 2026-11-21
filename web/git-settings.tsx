import { useEffect, useState } from "react";
import type { AgentService } from "../src/service.js";
import { api, ApiError } from "./api.js";
import { useNotify } from "./notifications.js";

type GitIdentity = Awaited<ReturnType<AgentService["workGitIdentity"]>>;
const path = "/api/settings/git";
const fields = [
  ["name", "作成者名"],
  ["email", "メールアドレス"],
] as const;

export function GitSettings({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void;
}) {
  const notify = useNotify();
  const [saved, setSaved] = useState<GitIdentity>();
  const [draft, setDraft] = useState<GitIdentity>();
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const dirty =
    !!draft && fields.some(([field]) => draft[field] !== saved?.[field]);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  async function load() {
    setBusy(true);
    setLoadFailed(false);
    try {
      const value = await api<GitIdentity>(path);
      setSaved(value);
      setDraft(value);
      setConflict(false);
    } catch (error) {
      setLoadFailed(true);
      notify(
        error instanceof Error ? error.message : "Git 設定を読み込めません",
        true,
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function save() {
    if (!draft || busy || !dirty) return;
    setBusy(true);
    try {
      const value = await api<GitIdentity>(path, "PUT", draft);
      setSaved(value);
      setDraft(value);
      setConflict(false);
      notify("保存しました。");
    } catch (error) {
      setConflict(error instanceof ApiError && error.status === 409);
      notify(
        error instanceof Error ? error.message : "Git 設定を保存できません",
        true,
      );
    } finally {
      setBusy(false);
    }
  }
  if (!draft)
    return loadFailed ? (
      <button
        className="btn-outline theme-secondary"
        onClick={() => void load()}
      >
        再試行
      </button>
    ) : (
      <p role="status">読み込み中…</p>
    );
  return (
    <form
      className="settings-card card card-body p-5 gap-4 mb-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset className="settings-form-grid" disabled={busy}>
        {fields.map(([field, label]) => (
          <label key={field} className="form-label d-block m-0">
            {label}
            <input
              className="form-control mt-1"
              inputMode={field === "email" ? "email" : undefined}
              autoComplete="off"
              maxLength={256}
              value={draft[field]}
              onChange={(event) =>
                setDraft({ ...draft, [field]: event.target.value })
              }
            />
          </label>
        ))}
      </fieldset>
      <div className="d-flex flex-wrap justify-content-end gap-3">
        {(conflict || loadFailed) && (
          <button
            type="button"
            className="btn-outline theme-secondary"
            disabled={busy}
            onClick={() => void load()}
          >
            再読み込み
          </button>
        )}
        <button
          type="submit"
          className="btn-solid theme-primary"
          disabled={busy || !dirty}
        >
          Git 設定を保存
        </button>
      </div>
    </form>
  );
}
