import { useEffect, useState } from "react";
import type { Project, ProjectBinding } from "../src/projects.js";
import { api, requestId, forget } from "./api.js";
import { useNotify } from "./notifications.js";
import { SettingsToolbar } from "./settings-layout.js";

type Draft = {
  id?: string;
  revision?: number;
  name: string;
  repositories: { url: string; branch: string }[];
};
const empty = (): Draft => ({
  name: "",
  repositories: [{ url: "", branch: "" }],
});
export function Projects({
  onDirtyChange,
}: {
  onDirtyChange: (value: boolean) => void;
}) {
  const notify = useNotify();
  const [projects, setProjects] = useState<Project[]>([]);
  const [draft, setDraft] = useState<Draft>(empty);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  async function reload() {
    try {
      setProjects(
        (await api<{ projects: Project[] }>("/api/projects")).projects,
      );
      setReloadNeeded(false);
    } catch (error) {
      setReloadNeeded(true);
      throw error;
    }
  }
  useEffect(() => {
    void reload().catch((error: unknown) =>
      notify(error instanceof Error ? error.message : "読み込みに失敗しました"),
    );
  }, []);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  function change(value: Draft) {
    setDraft(value);
    setDirty(true);
  }
  function edit(project?: Project) {
    if (dirty && !window.confirm("未保存のプロジェクトの変更を破棄しますか？"))
      return;
    setDraft(
      project
        ? {
            id: project.id,
            revision: project.revision,
            name: project.name,
            repositories: project.repositories.map((repo) => ({
              url: repo.remoteUrl,
              branch: repo.branch ?? "",
            })),
          }
        : empty(),
    );
    setDirty(false);
  }
  async function save() {
    setBusy(true);
    try {
      const input = {
        name: draft.name,
        repositories: draft.repositories.map((repo) => ({
          url: repo.url,
          ...(repo.branch ? { branch: repo.branch } : {}),
        })),
      };
      const project = await api<Project>(
        draft.id ? `/api/projects/${draft.id}` : "/api/projects",
        draft.id ? "PUT" : "POST",
        draft.id
          ? { ...input, revision: draft.revision }
          : { ...input, requestId: await requestId("project", input) },
      );
      forget("project");
      setDraft({ ...draft, id: project.id, revision: project.revision });
      setDirty(false);
      await reload();
      notify("プロジェクトを保存しました");
    } catch (error) {
      setReloadNeeded(true);
      notify(error instanceof Error ? error.message : "操作に失敗しました");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (
      !draft.id ||
      !window.confirm(`「${draft.name}」のプロジェクト定義を削除しますか？`)
    )
      return;
    setBusy(true);
    try {
      await api(`/api/projects/${draft.id}`, "DELETE", {
        revision: draft.revision,
      });
      setDraft(empty());
      setDirty(false);
      await reload();
      notify("プロジェクトを削除しました");
    } catch (error) {
      setReloadNeeded(true);
      notify(error instanceof Error ? error.message : "操作に失敗しました");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="projects-content" aria-label="プロジェクト設定">
      <SettingsToolbar>
        {projects.map((project) => (
          <button
            type="button"
            className="btn-outline theme-secondary"
            aria-pressed={draft.id === project.id}
            disabled={busy}
            key={project.id}
            onClick={() => edit(project)}
          >
            {project.name}
          </button>
        ))}
        <button
          type="button"
          className="btn-outline theme-secondary"
          disabled={busy}
          onClick={() => edit()}
        >
          プロジェクトを追加
        </button>
        {reloadNeeded && (
          <button
            type="button"
            className="btn-outline theme-secondary"
            disabled={busy}
            onClick={() =>
              void reload()
                .then(() => notify("一覧を再読み込みしました"))
                .catch((error: unknown) =>
                  notify(
                    error instanceof Error
                      ? error.message
                      : "読み込みに失敗しました",
                    true,
                  ),
                )
            }
          >
            一覧を再読み込み
          </button>
        )}
      </SettingsToolbar>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy}>
          <label className="form-label" htmlFor="project-name">
            プロジェクト名
          </label>
          <input
            id="project-name"
            className="form-control mb-3"
            required
            maxLength={100}
            value={draft.name}
            onChange={(e) => change({ ...draft, name: e.target.value })}
          />
          {draft.repositories.map((repo, index) => (
            <div className="mb-3" key={index}>
              <label className="form-label" htmlFor={`project-repo-${index}`}>
                リポジトリ {index + 1}
              </label>
              <input
                id={`project-repo-${index}`}
                className="form-control"
                placeholder="owner/repo"
                required
                maxLength={300}
                value={repo.url}
                onChange={(e) =>
                  change({
                    ...draft,
                    repositories: draft.repositories.map((r, i) =>
                      i === index ? { ...r, url: e.target.value } : r,
                    ),
                  })
                }
              />
              <label
                className="form-label mt-2"
                htmlFor={`project-branch-${index}`}
              >
                開始ブランチ {index + 1}（任意）
              </label>
              <input
                id={`project-branch-${index}`}
                className="form-control"
                maxLength={200}
                value={repo.branch}
                onChange={(e) =>
                  change({
                    ...draft,
                    repositories: draft.repositories.map((r, i) =>
                      i === index ? { ...r, branch: e.target.value } : r,
                    ),
                  })
                }
              />
              <button
                type="button"
                className="btn-outline theme-secondary mt-2"
                disabled={draft.repositories.length === 1}
                onClick={() =>
                  change({
                    ...draft,
                    repositories: draft.repositories.filter(
                      (_, i) => i !== index,
                    ),
                  })
                }
              >
                リポジトリ {index + 1} を削除
              </button>
            </div>
          ))}
          <div className="d-flex gap-2">
            <button
              type="button"
              className="btn-outline theme-secondary"
              disabled={draft.repositories.length >= 10}
              onClick={() =>
                change({
                  ...draft,
                  repositories: [
                    ...draft.repositories,
                    { url: "", branch: "" },
                  ],
                })
              }
            >
              リポジトリを追加
            </button>
            <button className="btn-solid theme-primary" disabled={!dirty}>
              プロジェクトを保存
            </button>
          </div>
          {draft.id && (
            <details className="mt-4">
              <summary>削除</summary>
              <button
                type="button"
                className="btn-outline theme-danger mt-2"
                onClick={() => void remove()}
              >
                プロジェクトを削除
              </button>
            </details>
          )}
        </fieldset>
      </form>
    </section>
  );
}
export function ProjectSummary({
  id,
  project,
  disabled,
}: {
  id: string;
  project: ProjectBinding;
  disabled: boolean;
}) {
  const [fetching, setFetching] = useState(false);
  const [results, setResults] =
    useState<{ key: string; ok: boolean; error?: string }[]>();
  const notify = useNotify();
  async function fetchRepositories() {
    setFetching(true);
    setResults(undefined);
    try {
      const response = await api<{
        results: { key: string; ok: boolean; error?: string }[];
      }>(`/api/conversations/${id}/repositories/fetch`, "POST", {});
      setResults(response.results);
      notify(
        response.results.every((r) => r.ok)
          ? "取得しました。作業ファイルは変更していません"
          : "一部のリポジトリを取得できませんでした",
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : "操作に失敗しました");
    } finally {
      setFetching(false);
    }
  }
  return (
    <details className="project-summary mx-3 my-2">
      <summary>{project.name}</summary>
      <ul>
        {project.repositories.map((repo) => (
          <li key={repo.key}>
            {repo.key} <code>{repo.baseCommit ?? "未準備"}</code>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn-outline theme-secondary btn-sm"
        disabled={disabled || fetching}
        title="共有 Git データだけを取得します。現在の作業ファイルは変更しません"
        onClick={() => void fetchRepositories()}
      >
        {fetching ? "取得中" : "取得更新"}
      </button>
      {results && (
        <ul role="status">
          {results.map((r) => (
            <li key={r.key}>
              {r.key}: {r.ok ? "取得済み" : r.error}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
