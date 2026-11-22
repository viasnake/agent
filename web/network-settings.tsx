import { useEffect, useState } from "react";
import type { Destination, DestinationSettings } from "../src/destinations.js";
import { api, ApiError } from "./api.js";
import { useNotify } from "./notifications.js";
import { SettingsEmpty } from "./settings-layout.js";

const path = "/api/settings/network";
const blank = { name: "", ip: "", port: 22 };

export function NetworkSettings({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void;
}) {
  const notify = useNotify();
  const [snapshot, setSnapshot] = useState<DestinationSettings>();
  const [editor, setEditor] = useState<{ index: number; value: Destination }>();
  const [portChoice, setPortChoice] = useState("22");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(false);
  useEffect(() => onDirtyChange(!!editor), [!!editor, onDirtyChange]);

  async function load() {
    setBusy(true);
    setError("");
    try {
      setSnapshot(await api<DestinationSettings>(path));
      setReload(false);
      setEditor(undefined);
    } catch (error) {
      setReload(true);
      setError(
        error instanceof Error ? error.message : "接続先を読み込めません",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function save(entries: Destination[]) {
    if (!snapshot || busy || reload) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<DestinationSettings>(path, "PUT", {
        revision: snapshot.revision,
        entries,
      });
      setSnapshot(result);
      setEditor(undefined);
      if (result.applied) notify("接続先の許可を適用しました。");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "接続先の許可を保存できません",
      );
      setReload(!(error instanceof ApiError && error.status === 400));
    } finally {
      setBusy(false);
    }
  }

  function edit(index: number, value = blank) {
    setPortChoice(
      value.port === 22 || value.port === 443 ? String(value.port) : "custom",
    );
    setError("");
    setEditor({ index, value });
  }

  function update(change: Partial<Destination>) {
    if (editor) setEditor({ ...editor, value: { ...editor.value, ...change } });
  }

  return (
    <section aria-label="接続先の許可">
      <h3 className="h5">接続先の許可</h3>
      <p className="fg-2">
        Agent に許可する IPv4 アドレスと TCP ポートを指定します。WARP
        の経路は変更されません。
      </p>
      {error && (
        <p role="alert" className="fg-danger">
          {error}
        </p>
      )}
      {reload && (
        <button
          type="button"
          className="btn-outline theme-secondary mb-5"
          disabled={busy}
          onClick={() => {
            if (
              !editor ||
              window.confirm("編集中の内容を破棄して再読み込みしますか？")
            )
              void load();
          }}
        >
          再読み込み
        </button>
      )}
      {!snapshot && !reload && <p role="status">読み込み中…</p>}
      {snapshot && (
        <>
          {!snapshot.applied && !reload && (
            <p role="status">
              許可設定が一致していません。
              <button
                type="button"
                className="btn-outline theme-secondary ms-2"
                disabled={busy || !!editor}
                onClick={() => void save(snapshot.entries)}
              >
                再適用
              </button>
            </p>
          )}
          {snapshot.applied && !reload && snapshot.entries.length > 0 && (
            <p className="fg-2" role="status">
              適用済み（接続は未確認）
            </p>
          )}
          {snapshot.entries.length === 0 && (
            <SettingsEmpty>接続先はまだ登録されていません</SettingsEmpty>
          )}
          <ul className="list-unstyled mb-5">
            {snapshot.entries.map(({ name, ip, port }, i) => (
              <li
                className="settings-card card card-body p-5 mb-3 flex-row flex-wrap align-items-center justify-content-between gap-3"
                key={`${ip}:${port}`}
              >
                <div className="min-w-0 text-break">
                  {name && <div className="fw-semibold">{name}</div>}
                  <div>
                    {ip} · TCP {port}
                    {port === 22 ? "（SSH）" : port === 443 ? "（HTTPS）" : ""}
                  </div>
                </div>
                <div className="d-flex gap-2">
                  <button
                    type="button"
                    className="btn-text theme-secondary"
                    disabled={busy || reload || !!editor}
                    onClick={() => edit(i, { name, ip, port })}
                  >
                    編集
                    <span className="visually-hidden">
                      {" "}
                      {ip}:{port}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn-text theme-danger"
                    disabled={busy || reload || !!editor}
                    onClick={() => {
                      if (
                        window.confirm(`${ip}:${port} の許可を削除しますか？`)
                      )
                        void save(
                          snapshot.entries.filter((_, index) => index !== i),
                        );
                    }}
                  >
                    削除
                    <span className="visually-hidden">
                      {" "}
                      {ip}:{port}
                    </span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {!editor && (
            <button
              type="button"
              className="btn-outline theme-primary"
              disabled={busy || reload || snapshot.entries.length >= 64}
              onClick={() => edit(-1)}
            >
              ＋ 接続先を追加
            </button>
          )}
          {editor && (
            <form
              className="settings-card card card-body p-5 gap-4"
              aria-label={editor.index < 0 ? "接続先を追加" : "接続先を編集"}
              onSubmit={(event) => {
                event.preventDefault();
                const value = {
                  ...editor.value,
                  name: editor.value.name.trim(),
                  ip: editor.value.ip.trim(),
                };
                void save(
                  editor.index < 0
                    ? [...snapshot.entries, value]
                    : snapshot.entries.map((old, i) =>
                        i === editor.index ? value : old,
                      ),
                );
              }}
            >
              <fieldset
                className="settings-form-grid"
                disabled={busy || reload}
              >
                <label className="form-label d-block m-0">
                  名前（任意）
                  <input
                    className="form-control mt-1"
                    maxLength={80}
                    value={editor.value.name}
                    onChange={(event) => update({ name: event.target.value })}
                  />
                </label>
                <label className="form-label d-block m-0">
                  IPv4 アドレス
                  <input
                    className="form-control mt-1"
                    required
                    autoComplete="off"
                    maxLength={15}
                    placeholder="10.10.20.62"
                    value={editor.value.ip}
                    onChange={(event) => update({ ip: event.target.value })}
                  />
                </label>
                <label className="form-label d-block m-0">
                  TCP ポート
                  <select
                    className="form-control mt-1"
                    value={portChoice}
                    onChange={(event) => {
                      const choice = event.target.value;
                      setPortChoice(choice);
                      if (choice !== "custom") update({ port: Number(choice) });
                    }}
                  >
                    <option value="22">SSH（22）</option>
                    <option value="443">HTTPS（443）</option>
                    <option value="custom">カスタム</option>
                  </select>
                </label>
                {portChoice === "custom" && (
                  <label className="form-label d-block m-0">
                    ポート番号
                    <input
                      className="form-control mt-1"
                      type="number"
                      required
                      min={1}
                      max={65535}
                      value={editor.value.port || ""}
                      onChange={(event) =>
                        update({ port: Number(event.target.value) })
                      }
                    />
                  </label>
                )}
              </fieldset>
              <div className="d-flex flex-wrap justify-content-end gap-3">
                <button
                  type="button"
                  className="btn-text theme-secondary"
                  disabled={busy}
                  onClick={() => setEditor(undefined)}
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  className="btn-solid theme-primary"
                  disabled={busy || reload}
                >
                  {busy ? "適用中…" : "保存"}
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
