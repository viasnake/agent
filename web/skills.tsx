import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { useNotify } from "./notifications.js";
import type {
  SkillDetail,
  SkillImport,
  SkillsManagement,
} from "../src/skills.js";

const fileLimit = 256 * 1024;
const importLimit = 4 * 1024 * 1024;
function encode(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768)
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}

export function Skills() {
  const [view, setView] = useState<SkillsManagement>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [acting, setActing] = useState(false);
  const [draft, setDraft] = useState<{
    content: string;
    editing?: SkillDetail;
    files: SkillImport["files"];
  }>();
  const request = useRef(0);
  const opener = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const notify = useNotify();
  const busy = acting || !view;
  const disabled = busy || !view?.writable || view.busy;
  useEffect(() => {
    const current = ++request.current;
    setError("");
    setView(undefined);
    void api<SkillsManagement>("/api/skills").then(
      (value) => {
        if (current === request.current) setView(value);
      },
      (e: Error) => {
        if (current === request.current) setError(e.message);
      },
    );
    return () => {
      request.current++;
    };
  }, [revision]);

  useEffect(() => {
    if (!acting && !draft && restoreFocus.current) {
      restoreFocus.current = false;
      opener.current?.focus();
    }
  }, [acting, draft]);

  async function action(run: () => Promise<void>) {
    if (acting) return;
    setActing(true);
    setError("");
    try {
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作できませんでした");
    } finally {
      setActing(false);
    }
  }
  function closeDraft() {
    setDraft(undefined);
    restoreFocus.current = true;
  }
  async function selectFiles(files: File[]) {
    await action(async () => {
      if (!files.length) return;
      if (
        files.length > 256 ||
        files.some((file) => file.size > fileLimit) ||
        files.reduce((sum, file) => sum + file.size, 0) > importLimit
      )
        throw new Error(
          "Skill は256件・合計4 MiB、各ファイルは256 KiBまでです",
        );
      const entries: SkillImport["files"] = [];
      let content: string | undefined;
      for (const file of files) {
        const path = file.webkitRelativePath
          ? file.webkitRelativePath.split("/").slice(1).join("/")
          : file.name;
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (path === "SKILL.md") {
          if (bytes.length > 65536)
            throw new Error("Skill の本文は64 KiBまでです");
          try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw new Error("SKILL.md は UTF-8 テキストで保存してください");
          }
        } else entries.push({ path, data: encode(bytes) });
      }
      if (content === undefined)
        throw new Error("フォルダー直下の SKILL.md を選択してください");
      setDraft({ content, files: entries });
    });
  }
  return (
    <section
      className="skills-list"
      aria-label="Skills 一覧"
      aria-busy={acting}
    >
      <div className="settings-actions">
        <button
          ref={addButton}
          type="button"
          className="btn-outline theme-secondary"
          disabled={disabled || !!draft}
          onClick={(event) => {
            opener.current = event.currentTarget;
            setError("");
            setDraft({ content: "", files: [] });
          }}
        >
          Skill を追加
        </button>
        <button
          type="button"
          className="btn-text theme-secondary"
          disabled={acting}
          onClick={() => setRevision((v) => v + 1)}
        >
          再読み込み
        </button>
      </div>
      {error && (
        <p role="alert" className="fg-danger">
          {error}
        </p>
      )}
      {!view && !error && <p role="status">読み込み中…</p>}
      {view && !view.writable && (
        <p role="alert">
          Skills を管理するには、サービスを停止してアプリを更新してください
        </p>
      )}
      {view?.busy && (
        <p role="status">変更するには実行中のセッションを停止してください</p>
      )}
      {view?.errors.map((message) => (
        <p key={message} role="alert">
          {message}
        </p>
      ))}
      {draft && (
        <form
          className="settings-card"
          aria-label={draft.editing ? "Skill を編集" : "Skill を追加"}
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled) return;
            void action(async () => {
              if (new TextEncoder().encode(draft.content).length > 65536)
                throw new Error("Skill の本文は64 KiBまでです");
              const value = draft.editing
                ? await api<SkillsManagement>(
                    `/api/skills/${draft.editing.name}`,
                    "PUT",
                    {
                      content: draft.content,
                      revision: draft.editing.revision,
                    },
                  )
                : await api<SkillsManagement>("/api/skills", "POST", {
                    files: [
                      {
                        path: "SKILL.md",
                        data: encode(new TextEncoder().encode(draft.content)),
                      },
                      ...draft.files,
                    ],
                  });
              setView(value);
              closeDraft();
              notify(
                draft.editing ? "Skill を保存しました" : "Skill を追加しました",
              );
            });
          }}
        >
          {!draft.editing && (
            <div className="settings-actions">
              <button
                type="button"
                className="btn-outline theme-secondary"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                SKILL.md を選択
              </button>
              <button
                type="button"
                className="btn-outline theme-secondary"
                disabled={busy}
                onClick={() => folderInput.current?.click()}
              >
                フォルダーを選択
              </button>
              <input
                ref={fileInput}
                type="file"
                aria-label="SKILL.md を選択"
                accept=".md"
                hidden
                onChange={(event) => {
                  void selectFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
              <input
                ref={folderInput}
                type="file"
                aria-label="フォルダーを選択"
                multiple
                hidden
                {...{ webkitdirectory: "" }}
                onChange={(event) => {
                  void selectFiles(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
            </div>
          )}
          <label className="form-label">
            SKILL.md
            <textarea
              className="form-control skill-source"
              rows={12}
              maxLength={65536}
              value={draft.content}
              autoFocus
              disabled={busy}
              placeholder={
                "---\nname: my-skill\ndescription: Skill の説明\n---\n手順を記述"
              }
              onChange={(event) =>
                setDraft({ ...draft, content: event.target.value })
              }
            />
          </label>
          {!!draft.files.length && (
            <details>
              <summary>補助ファイル（{draft.files.length}件）</summary>
              <ul>
                {draft.files.map((file) => (
                  <li key={file.path}>{file.path}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="settings-actions">
            <button
              type="submit"
              className="btn-solid theme-primary"
              disabled={disabled || !draft.content.trim()}
            >
              {draft.editing ? "保存" : "追加"}
            </button>
            <button
              type="button"
              className="btn-text theme-secondary"
              disabled={acting}
              onClick={closeDraft}
            >
              キャンセル
            </button>
          </div>
        </form>
      )}
      {view?.skills.length === 0 && <p>Skills はありません</p>}
      {view?.skills.map((skill) => (
        <article className="settings-card" key={skill.name}>
          <h2>{skill.name}</h2>
          <p>{skill.state === "ready" ? "利用可能" : "読み込みエラー"}</p>
          {skill.description && <p>{skill.description}</p>}
          {skill.compatibility && <p>互換性: {skill.compatibility}</p>}
          {skill.error && <p role="alert">{skill.error}</p>}
          <div className="settings-actions">
            <button
              type="button"
              className="btn-text theme-secondary"
              disabled={disabled || !!draft || !skill.revision}
              aria-label={`${skill.name} を編集`}
              onClick={(event) => {
                opener.current = event.currentTarget;
                void action(async () => {
                  const editing = await api<SkillDetail>(
                    `/api/skills/${skill.name}`,
                  );
                  setDraft({ content: editing.content, editing, files: [] });
                });
              }}
            >
              編集
            </button>
            <button
              type="button"
              className="btn-text theme-danger"
              disabled={disabled || !!draft || !skill.revision}
              aria-label={`${skill.name} を削除`}
              onClick={() => {
                if (
                  !window.confirm(
                    `${skill.name} と補助ファイルを削除しますか？`,
                  )
                )
                  return;
                void action(async () => {
                  setView(
                    await api<SkillsManagement>(
                      `/api/skills/${skill.name}`,
                      "DELETE",
                      { revision: skill.revision },
                    ),
                  );
                  opener.current = addButton.current;
                  restoreFocus.current = true;
                  notify("Skill を削除しました");
                });
              }}
            >
              削除
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
