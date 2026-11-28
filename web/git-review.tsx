import Menu from "bootstrap/js/dist/menu.js";
import { useEffect, useId, useRef, useState } from "react";
import type { GitReviewResult } from "../src/git-review.js";
import { api } from "./api.js";
import { GitPatch } from "./git-patch.js";
import { Icon } from "./icons.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js";

type Repositories = Extract<GitReviewResult, { kind: "repositories" }>;
type History = Extract<GitReviewResult, { kind: "history" }>;
type Changes = Extract<GitReviewResult, { kind: "changes" }>;
type FileChange = Changes["files"][number];
type Comparison = "working" | "committed";
const reasons = {
  repository: "このリポジトリには対応していません。",
  commit: "比較できるコミットがありません。一覧を更新してください。",
  changed: "HEAD が変わりました。一覧を更新してください。",
  binary: "バイナリまたは UTF-8 以外の差分は表示できません。",
  limit: "取得上限を超えたため表示できません。",
  file: "このファイルの差分は表示できません。",
};
const statuses = {
  A: "追加",
  D: "削除",
  M: "変更",
  T: "種類変更",
  U: "競合",
  "?": "未追跡",
};
const fileKey = ({ path, status }: FileChange) => `${status}:${path}`;
const repositoryLabel = (path: string) =>
  path === "." ? "スレッドの作業フォルダ" : path;
function unavailable(result: GitReviewResult) {
  return result.kind === "unavailable"
    ? reasons[result.reason]
    : "Git の変更を読み込めませんでした。";
}

function FileName({ path }: { path: string }) {
  const lastSlash = path.lastIndexOf("/");
  return (
    <span className="git-review-name">
      <bdi className="fw-semibold">{path.slice(lastSlash + 1)}</bdi>
      {lastSlash >= 0 && (
        <bdi className="small fg-2">{path.slice(0, lastSlash)}</bdi>
      )}
    </span>
  );
}

function ComparisonMenu({
  history,
  base,
  onSelect,
}: {
  history: History;
  base: string;
  onSelect: (oid: string) => void;
}) {
  const menuId = useId();
  const labelId = useId();
  const valueId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const automatic = history.commits[0]!;
  const selected = history.commits.find(({ oid }) => oid === base);
  const subject = (commit: History["commits"][number]) =>
    commit.subject || "メッセージなし";
  useEffect(() => {
    const button = trigger.current!;
    return () => Menu.getInstance(button)?.dispose();
  }, []);
  function choose(oid: string) {
    trigger.current?.focus({ preventScroll: true });
    onSelect(oid);
  }
  function option(oid: string, title: string, description: string) {
    const current = (selected?.oid ?? "") === oid;
    return (
      <button
        key={oid}
        type="button"
        role="menuitemradio"
        aria-checked={current}
        className={`menu-item text-wrap${current ? " selected" : ""}`}
        onClick={() => choose(oid)}
      >
        <span className="menu-item-content">
          <bdi className="text-break">{title}</bdi>
          <span className="menu-item-description">{description}</span>
        </span>
        <span className="menu-item-check">
          <Icon name="check" />
        </span>
      </button>
    );
  }
  return (
    <div className="git-review-compare">
      <span className="form-label mb-0" id={labelId}>
        比較の起点
      </span>
      <div>
        <button
          ref={trigger}
          type="button"
          className="btn-outline theme-secondary w-100 d-flex align-items-center justify-content-between gap-2 text-start"
          data-bs-toggle="menu"
          data-bs-strategy="fixed"
          aria-haspopup="menu"
          aria-expanded="false"
          aria-controls={menuId}
          aria-labelledby={`${labelId} ${valueId}`}
        >
          <span className="text-truncate" id={valueId}>
            {selected ? (
              <bdi>{subject(selected)}</bdi>
            ) : (
              <>
                自動：<bdi>{subject(automatic)}</bdi>
              </>
            )}
          </span>
          <Icon name="chevron" />
        </button>
        <div
          id={menuId}
          className="menu menu-scrollable git-comparison-menu"
          role="menu"
          aria-labelledby={labelId}
        >
          {option("", "自動（直前のコミット）", subject(automatic))}
          <hr className="menu-divider" role="separator" />
          {history.commits.map((commit) =>
            option(
              commit.oid,
              subject(commit),
              `${commit.date} · ${commit.oid.slice(0, 8)}`,
            ),
          )}
          {history.limited && (
            <div className="menu-text small" role="presentation">
              直近 {history.commits.length} 件を表示
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function GitReview({ id, running }: { id: string; running: boolean }) {
  const [repositories, setRepositories] = useState<Repositories>();
  const [repo, setRepo] = useState("");
  const [mode, setMode] = useState<Comparison>("working");
  const [history, setHistory] = useState<History>();
  const [historyError, setHistoryError] = useState("");
  const [base, setBase] = useState("");
  const [changes, setChanges] = useState<Changes>();
  const [selection, setSelection] = useState<string>();
  const [patch, setPatch] = useState<{
    key: string;
    text?: string;
    error?: string;
  }>();
  const [repositoriesError, setRepositoriesError] = useState("");
  const [changesError, setChangesError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const focusMobileDetail = useRef(false);
  const focusMobileList = useRef<number | undefined>(undefined);
  const endpoint = `/api/conversations/${id}/git`;

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

  useEffect(() => {
    setHistory(undefined);
    setHistoryError("");
    if (running || !repo || mode !== "committed") return;
    const request = new AbortController();
    const params = new URLSearchParams({ repo });
    void api<GitReviewResult>(
      `${endpoint}/history?${params}`,
      "GET",
      undefined,
      request.signal,
    )
      .then((result) => {
        if (request.signal.aborted) return;
        if (result.kind === "history") {
          setHistory(result);
          setBase((previous) =>
            result.commits.some(({ oid }) => oid === previous) ? previous : "",
          );
        } else setHistoryError(unavailable(result));
      })
      .catch((error: Error) => {
        if (!request.signal.aborted) setHistoryError(error.message);
      });
    return () => request.abort();
  }, [endpoint, repo, mode, running, refresh]);

  const selectedCommit =
    history?.commits.find(({ oid }) => oid === base) ?? history?.commits[0];
  const comparison = mode === "committed" ? (selectedCommit?.oid ?? "") : "";

  useEffect(() => {
    setChanges(undefined);
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
    return () => request.abort();
  }, [endpoint, repo, mode, comparison, running, refresh]);

  const file = changes?.files.find((entry) => fileKey(entry) === selection);
  const head = changes?.head;
  useEffect(() => {
    setPatch(undefined);
    if (running || !file || !head) return;
    const key = fileKey(file);
    const request = new AbortController();
    const params = new URLSearchParams({
      repo,
      head,
      path: file.path,
      ...(file.status === "?" ? { untracked: "1" } : {}),
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
    return () => request.abort();
  }, [file, head, repo, comparison, endpoint, running]);

  useEffect(() => {
    if (file && focusMobileDetail.current) {
      focusMobileDetail.current = false;
      back.current?.focus();
    }
    if (!file && focusMobileList.current !== undefined) {
      list.current
        ?.querySelectorAll("button")
        [focusMobileList.current]?.focus();
      focusMobileList.current = undefined;
    }
  }, [file]);

  const visiblePatch = file && patch?.key === fileKey(file) ? patch : undefined;
  const hasRepository = Boolean(
    repo && repositories?.repositories.includes(repo) && !repositoriesError,
  );
  const waitingForBase = mode === "committed" && !comparison;
  return (
    <section className="git-review" aria-labelledby="git-review-title">
      <header className="files-section-heading">
        <div className="d-flex align-items-center gap-2">
          <Icon name="diff" />
          <h2 className="h5 m-0" id="git-review-title">
            コードの変更
          </h2>
        </div>
        <button
          className="btn-outline theme-secondary btn-sm d-inline-flex align-items-center gap-2"
          type="button"
          aria-label="Git の変更を更新"
          disabled={running}
          onClick={() => {
            setChanges(undefined);
            setHistory(undefined);
            setHistoryError("");
            setRefresh((value) => value + 1);
          }}
        >
          <Icon name="retry" />
          更新
        </button>
      </header>
      {running ? (
        <p className="git-review-state" role="status">
          応答が終わると変更を確認できます。
        </p>
      ) : repositoriesError ? (
        <p className="git-review-state" role="alert">
          {repositoriesError}
        </p>
      ) : !repositories ? (
        <p className="git-review-state" role="status">
          リポジトリを確認中…
        </p>
      ) : !hasRepository ? (
        <p className="git-review-state">
          {repositories.limited
            ? "検索上限に達し、対象のリポジトリを確認できませんでした。"
            : "スレッド内に Git クローンはありません"}
        </p>
      ) : (
        <>
          <div className="git-review-repo">
            <Icon name="fork" />
            {repositories.repositories.length === 1 ? (
              <bdi className="text-break">{repositoryLabel(repo)}</bdi>
            ) : (
              <select
                className="form-select form-select-sm"
                aria-label="リポジトリ"
                value={repo}
                onChange={(event) => {
                  setChanges(undefined);
                  setSelection(undefined);
                  setRepo(event.target.value);
                  setHistory(undefined);
                  setHistoryError("");
                  setBase("");
                  setMode("working");
                }}
              >
                {repositories.repositories.map((path) => (
                  <option key={path} value={path}>
                    {repositoryLabel(path)}
                  </option>
                ))}
              </select>
            )}
            {repositories.limited && (
              <small className="fg-2">一部のリポジトリのみ表示</small>
            )}
          </div>
          <Tabs
            value={mode}
            onValueChange={(value) => {
              setChanges(undefined);
              setChangesError("");
              setSelection(undefined);
              setHistory(undefined);
              setHistoryError("");
              setMode(value === "committed" ? "committed" : "working");
            }}
          >
            <TabsList aria-label="変更の比較対象" className="git-review-tabs">
              <TabsTrigger value="working">未コミット</TabsTrigger>
              <TabsTrigger value="committed">コミット済み</TabsTrigger>
            </TabsList>
            <TabsContent value={mode}>
              {mode === "committed" &&
                history &&
                history.commits.length > 0 && (
                  <ComparisonMenu
                    history={history}
                    base={base}
                    onSelect={(oid) => {
                      if ((oid || history.commits[0]!.oid) !== comparison) {
                        setChanges(undefined);
                        setSelection(undefined);
                      }
                      setBase(oid);
                    }}
                  />
                )}
              {changesError ? (
                <p className="git-review-state" role="alert">
                  {changesError}
                </p>
              ) : waitingForBase ? (
                historyError ? (
                  <p className="git-review-state" role="alert">
                    {historyError}
                  </p>
                ) : !history ? (
                  <p className="git-review-state" role="status">
                    コミット履歴を読み込み中…
                  </p>
                ) : (
                  <p className="git-review-state">
                    このクローンには、現在のコミットより前の履歴がありません。
                  </p>
                )
              ) : !changes ? (
                <p className="git-review-state" role="status">
                  変更一覧を読み込み中…
                </p>
              ) : (
                <>
                  <div className="git-review-summary small fg-2">
                    {comparison ? (
                      <>
                        <bdi title={comparison}>
                          {selectedCommit?.subject || "メッセージなし"}
                        </bdi>
                        <span> → </span>
                        <span>
                          現在のコミット{" "}
                          <code title={head}>{head?.slice(0, 8)}</code>
                        </span>
                      </>
                    ) : (
                      <>
                        <span>
                          HEAD <code title={head}>{head?.slice(0, 8)}</code>
                        </span>
                        <span> → 作業ツリー</span>
                      </>
                    )}
                  </div>
                  {!changes.files.length ? (
                    <p className="git-review-state">
                      {changes.limited
                        ? "表示できる変更はありません。"
                        : mode === "working"
                          ? "未コミットの変更はありません。"
                          : "この範囲に変更はありません。"}
                    </p>
                  ) : (
                    <div
                      className="git-review-layout"
                      data-detail={Boolean(file)}
                    >
                      <div className="git-review-list">
                        <h3 className="git-review-pane-heading">
                          変更ファイル{" "}
                          <span className="badge badge-subtle theme-secondary">
                            {changes.files.length}
                            {changes.limited ? "+" : ""}
                          </span>
                        </h3>
                        <ul ref={list} className="list-unstyled m-0">
                          {changes.files.map((entry) => {
                            const key = fileKey(entry);
                            return (
                              <li key={key}>
                                <button
                                  type="button"
                                  className="git-review-file"
                                  aria-pressed={selection === key}
                                  aria-label={`${statuses[entry.status]}: ${entry.path}`}
                                  onClick={() => {
                                    if (
                                      matchMedia("(max-width: 767px)").matches
                                    )
                                      focusMobileDetail.current = true;
                                    setSelection(key);
                                  }}
                                >
                                  <FileName path={entry.path} />
                                  <span
                                    className={`badge badge-subtle ${entry.status === "D" ? "theme-danger" : entry.status === "A" || entry.status === "?" ? "theme-success" : "theme-secondary"}`}
                                  >
                                    {statuses[entry.status]}
                                  </span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                      <section
                        className="git-review-detail"
                        aria-label="ファイルの差分"
                      >
                        {file ? (
                          <>
                            <button
                              ref={back}
                              type="button"
                              className="git-review-back btn-text theme-secondary btn-sm"
                              onClick={() => {
                                focusMobileList.current =
                                  changes.files.indexOf(file);
                                setSelection(undefined);
                              }}
                            >
                              <Icon name="left" />
                              変更ファイルに戻る
                            </button>
                            <div className="git-review-pane-heading">
                              <Icon name="file" />
                              <FileName path={file.path} />
                            </div>
                            {visiblePatch?.text ? (
                              <GitPatch
                                key={fileKey(file)}
                                text={visiblePatch.text}
                              />
                            ) : (
                              <p className="git-review-state m-0" role="status">
                                {visiblePatch?.error ??
                                  (visiblePatch?.text === ""
                                    ? "表示できる差分がありません。一覧を更新してください。"
                                    : "差分を読み込み中…")}
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="git-review-prompt">
                            <Icon name="diff" />
                            変更ファイルを選択すると差分を表示します。
                          </p>
                        )}
                      </section>
                    </div>
                  )}
                  {changes.limited && (
                    <p className="small fg-2 mt-2 mb-0">
                      表示上限に達したため、一部の変更のみ表示しています。
                    </p>
                  )}
                </>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </section>
  );
}
