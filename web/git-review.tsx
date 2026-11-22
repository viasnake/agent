import { useCallback, useEffect, useRef, useState } from "react";
import type { GitReviewResult } from "../src/git-review.js";
import { api } from "./api.js";

type Repositories = Extract<GitReviewResult, { kind: "repositories" }>;
type Changes = Extract<GitReviewResult, { kind: "changes" }>;
const reasons = {
  repository: "この Git リポジトリは確認できません",
  commit: "比較するコミットがこのリポジトリにありません",
  changed: "リポジトリの状態が変わりました。変更一覧を更新してください",
  binary: "バイナリまたは UTF-8 以外の差分は表示できません",
  limit: "取得上限を超えたため表示できません",
  file: "このファイルの差分は表示できません",
};
const statuses = {
  A: "追加",
  D: "削除",
  M: "変更",
  T: "種類変更",
  U: "競合",
  "?": "未追跡",
};
function unavailable(result: GitReviewResult) {
  if (result.kind === "unavailable") return reasons[result.reason];
  return "Git の変更を読み込めませんでした";
}

export function GitReview({ id, running }: { id: string; running: boolean }) {
  const [repositories, setRepositories] = useState<Repositories>();
  const [repo, setRepo] = useState("");
  const [mode, setMode] = useState<"working" | "committed">("working");
  const [commit, setCommit] = useState("");
  const [base, setBase] = useState("");
  const [changes, setChanges] = useState<Changes>();
  const [patch, setPatch] = useState<{
    key: string;
    text?: string;
    error?: string;
  }>();
  const [repositoriesError, setRepositoriesError] = useState("");
  const [changesError, setChangesError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const patchRequest = useRef<AbortController | undefined>(undefined);
  const endpoint = `/api/conversations/${id}/git`;
  const closePatch = useCallback(() => {
    patchRequest.current?.abort();
    setPatch(undefined);
  }, []);

  useEffect(() => {
    if (running) return;
    const request = new AbortController();
    setRepositoriesError("");
    void api<GitReviewResult>(
      `${endpoint}/repositories`,
      "GET",
      undefined,
      request.signal,
    )
      .then((result) => {
        if (request.signal.aborted) return;
        if (result.kind !== "repositories") {
          setRepositoriesError(unavailable(result));
          return;
        }
        setRepositories(result);
        setRepo((previous) =>
          result.repositories.includes(previous)
            ? previous
            : (result.repositories[0] ?? ""),
        );
      })
      .catch((error: Error) => {
        if (!request.signal.aborted) setRepositoriesError(error.message);
      });
    return () => request.abort();
  }, [endpoint, running, refresh]);

  const comparison = mode === "committed" ? base : "";
  useEffect(() => {
    setChanges(undefined);
    closePatch();
    setChangesError("");
    if (running || !repo || (mode === "committed" && !comparison)) return;
    const request = new AbortController();
    const params = new URLSearchParams({
      repo,
      ...(comparison ? { base: comparison } : {}),
    });
    void api<GitReviewResult>(
      `${endpoint}/changes?${params}`,
      "GET",
      undefined,
      request.signal,
    )
      .then((result) => {
        if (request.signal.aborted) return;
        if (result.kind === "changes") setChanges(result);
        else setChangesError(unavailable(result));
      })
      .catch((error: Error) => {
        if (!request.signal.aborted) setChangesError(error.message);
      });
    return () => {
      request.abort();
      patchRequest.current?.abort();
    };
  }, [closePatch, endpoint, repo, mode, comparison, running, refresh]);

  function openPatch(
    key: string,
    path: string,
    status: keyof typeof statuses,
    head: string,
  ) {
    closePatch();
    if (patch?.key === key) return;
    const request = new AbortController();
    patchRequest.current = request;
    setPatch({ key });
    const params = new URLSearchParams({
      repo,
      head,
      path,
      ...(status === "?" ? { untracked: "1" } : {}),
      ...(comparison ? { base: comparison } : {}),
    });
    void api<GitReviewResult>(
      `${endpoint}/patch?${params}`,
      "GET",
      undefined,
      request.signal,
    )
      .then((result) => {
        if (request.signal.aborted) return;
        setPatch(
          result.kind === "patch"
            ? { key, text: result.text }
            : { key, error: unavailable(result) },
        );
      })
      .catch((error: Error) => {
        if (!request.signal.aborted) setPatch({ key, error: error.message });
      });
  }
  return (
    <section className="output-files" aria-label="Git の変更">
      <div className="output-label">
        <span>Git の変更</span>
        <button
          className="btn-text theme-secondary btn-sm"
          type="button"
          disabled={running}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Git の変更を更新
        </button>
      </div>
      {running ? (
        <p role="status">実行が終わると変更を確認できます</p>
      ) : repositoriesError ? (
        <p role="alert">{repositoriesError}</p>
      ) : !repositories ? (
        <p role="status">リポジトリを確認中…</p>
      ) : (
        <>
          {repositories.limited && (
            <p className="small fg-2">リポジトリの検索上限に達しました</p>
          )}
          {repo ? (
            <>
              <label className="d-block mb-2">
                リポジトリ
                <select
                  className="form-select"
                  value={repo}
                  onChange={(event) => {
                    closePatch();
                    setChanges(undefined);
                    setRepo(event.target.value);
                    setCommit("");
                    setBase("");
                  }}
                >
                  {repositories.repositories.map((path) => (
                    <option key={path} value={path}>
                      {path === "." ? "セッションの作業フォルダ" : path}
                    </option>
                  ))}
                </select>
              </label>
              <label className="d-block mb-2">
                比較対象
                <select
                  className="form-select"
                  value={mode}
                  onChange={(event) => {
                    closePatch();
                    setChanges(undefined);
                    setMode(
                      event.target.value === "committed"
                        ? "committed"
                        : "working",
                    );
                  }}
                >
                  <option value="working">未コミットの変更（HEAD 基準）</option>
                  <option value="committed">
                    コミット済みの変更（基準コミット → HEAD）
                  </option>
                </select>
              </label>
              {mode === "committed" && (
                <form
                  className="mb-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    closePatch();
                    setBase(commit.trim());
                    setRefresh((value) => value + 1);
                  }}
                >
                  <label className="d-block">
                    基準コミットの SHA（40 桁）
                    <input
                      className="form-control"
                      value={commit}
                      required
                      pattern="[0-9a-fA-F]{40}"
                      onChange={(event) => setCommit(event.target.value)}
                    />
                  </label>
                  <button
                    className="btn-outline theme-secondary btn-sm mt-2"
                    type="submit"
                  >
                    比較
                  </button>
                </form>
              )}
              {changesError ? (
                <p role="alert">{changesError}</p>
              ) : changes ? (
                <>
                  <p className="small fg-2">
                    {comparison && (
                      <>
                        <code>{comparison.slice(0, 12)}</code> →{" "}
                      </>
                    )}
                    HEAD <code>{changes.head.slice(0, 12)}</code>
                  </p>
                  {!changes.files.length && <p>変更はありません</p>}
                  <ul className="list-unstyled">
                    {changes.files.map(({ path, status }, index) => {
                      const key = `${status}:${path}`;
                      return (
                        <li key={key}>
                          <button
                            className="btn-text theme-secondary text-start text-break"
                            type="button"
                            aria-expanded={patch?.key === key}
                            aria-controls={`git-patch-${index}`}
                            onClick={() =>
                              openPatch(key, path, status, changes.head)
                            }
                          >
                            {statuses[status]}: <bdi>{path}</bdi>
                          </button>
                          <div
                            id={`git-patch-${index}`}
                            hidden={patch?.key !== key}
                          >
                            {patch?.key === key &&
                              (patch.error ? (
                                <p role="status">{patch.error}</p>
                              ) : patch.text === undefined ? (
                                <p role="status">差分を読み込み中…</p>
                              ) : patch.text ? (
                                <pre className="git-review-patch" tabIndex={0}>
                                  {patch.text}
                                </pre>
                              ) : (
                                <p role="status">
                                  表示できる差分はありません。必要に応じて一覧を更新してください。
                                </p>
                              ))}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {changes.limited && (
                    <p className="small fg-2">一覧の一部を表示できません</p>
                  )}
                </>
              ) : (
                (mode === "working" || comparison) && (
                  <p role="status">変更一覧を読み込み中…</p>
                )
              )}
            </>
          ) : (
            <p>セッション内に Git クローンはありません</p>
          )}
        </>
      )}
    </section>
  );
}
