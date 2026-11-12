import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkCredentialInput } from "../src/work-credentials.js";
import type { CredentialOption } from "./api.js";

type Row = { name: string; value?: string };
export function CredentialSettings({
  entries,
  saved,
  environments,
  onEnvironments,
  onChange,
  onError,
}: {
  entries: WorkCredentialInput[];
  saved: CredentialOption[];
  environments: Record<string, Row[]>;
  onEnvironments: (id: string, rows: Row[]) => void;
  onChange: (entries: WorkCredentialInput[]) => void;
  onError: (message: string) => void;
}) {
  const latest = useRef(entries);
  latest.current = entries;
  const [expanded, setExpanded] = useState<string[]>([]);
  return (
    <>
      {entries.map((entry) => {
        const current = saved.find((c) => c.id === entry.id);
        const update = (next: WorkCredentialInput) =>
          onChange(entries.map((c) => (c.id === entry.id ? next : c)));
        const rows: Row[] =
          environments[entry.id] ??
          current?.envNames?.map((name) => ({ name })) ??
          [];
        return (
          <details
            key={entry.id}
            className="settings-disclosure"
            open={expanded.includes(entry.id)}
            onToggle={(event) => {
              const open = event.currentTarget.open;
              setExpanded((old) =>
                open
                  ? [...new Set([...old, entry.id])]
                  : old.filter((id) => id !== entry.id),
              );
            }}
          >
            <summary>
              <span>{entry.name || "新しいクレデンシャル"}</span>
              <small>{entry.kind === "env" ? "環境変数" : "SSH 鍵"}</small>
            </summary>
            <div className="settings-card">
              <label className="form-label">
                名前
                <input
                  className="form-control"
                  value={entry.name}
                  maxLength={100}
                  onChange={(e) => update({ ...entry, name: e.target.value })}
                />
              </label>
              {entry.kind === "env" ? (
                <div className="environment-fields">
                  <span>環境変数</span>
                  {rows.map((row, index) => (
                    <div className="environment-row" key={index}>
                      <input
                        className="form-control"
                        aria-label={`環境変数名 ${index + 1}`}
                        placeholder="GH_TOKEN"
                        value={row.name}
                        onChange={(e) =>
                          onEnvironments(
                            entry.id,
                            rows.map((r, i) =>
                              i === index
                                ? { name: e.target.value, value: r.value ?? "" }
                                : r,
                            ),
                          )
                        }
                      />
                      <input
                        className="form-control"
                        type="password"
                        autoComplete="new-password"
                        aria-label={`環境変数の値 ${index + 1}`}
                        placeholder={
                          row.value === undefined ? "••••••••" : "値"
                        }
                        value={row.value ?? ""}
                        onChange={(e) =>
                          onEnvironments(
                            entry.id,
                            rows.map((r, i) =>
                              i === index ? { ...r, value: e.target.value } : r,
                            ),
                          )
                        }
                      />
                      <button
                        type="button"
                        className="btn-text theme-danger btn-sm"
                        aria-label={`環境変数 ${index + 1} を削除`}
                        onClick={() =>
                          onEnvironments(
                            entry.id,
                            rows.filter((_, i) => i !== index),
                          )
                        }
                      >
                        削除
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn-outline theme-secondary btn-sm"
                    disabled={rows.length >= 100}
                    onClick={() =>
                      onEnvironments(entry.id, [
                        ...rows,
                        { name: "", value: "" },
                      ])
                    }
                  >
                    環境変数を追加
                  </button>
                </div>
              ) : (
                <>
                  {!current && (
                    <label className="settings-check">
                      <input
                        type="checkbox"
                        checked={!!entry.generateKey}
                        onChange={(e) =>
                          update({
                            ...entry,
                            generateKey: e.target.checked ? true : undefined,
                            privateKey: undefined,
                          })
                        }
                      />
                      新しい鍵を生成
                    </label>
                  )}
                  <label className="form-label">
                    秘密鍵（パスフレーズなし）
                    <textarea
                      className="form-control"
                      aria-label="秘密鍵（パスフレーズなし）"
                      disabled={!!entry.generateKey}
                      rows={5}
                      autoComplete="off"
                      spellCheck={false}
                      value={entry.privateKey ?? ""}
                      placeholder={
                        current
                          ? "登録済み"
                          : "-----BEGIN OPENSSH PRIVATE KEY-----"
                      }
                      onChange={(e) =>
                        update({ ...entry, privateKey: e.target.value })
                      }
                    />
                  </label>
                  <label className="form-label">
                    鍵ファイル
                    <input
                      type="file"
                      disabled={!!entry.generateKey}
                      className="form-control"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        if (file.size > 16384) {
                          onError("SSH 鍵は16 KiBまでです");
                          return;
                        }
                        void file
                          .text()
                          .then((privateKey) => {
                            onChange(
                              latest.current.map((current) =>
                                current.id === entry.id &&
                                current.kind === "ssh"
                                  ? {
                                      ...current,
                                      privateKey,
                                      generateKey: undefined,
                                    }
                                  : current,
                              ),
                            );
                          })
                          .catch(() => onError("鍵ファイルを読み込めません"));
                      }}
                    />
                  </label>
                  {current?.publicKey && (
                    <label className="form-label">
                      公開鍵
                      <textarea
                        className="form-control"
                        aria-label="公開鍵"
                        readOnly
                        rows={3}
                        value={current.publicKey}
                        onFocus={(e) => e.target.select()}
                      />
                    </label>
                  )}
                </>
              )}
              <button
                type="button"
                className="btn-text theme-danger btn-sm"
                onClick={() =>
                  onChange(entries.filter((c) => c.id !== entry.id))
                }
              >
                クレデンシャルを削除
              </button>
            </div>
          </details>
        );
      })}
      <div className="d-flex gap-2 flex-wrap">
        {(
          [
            ["env", "環境変数を登録"],
            ["ssh", "SSH 鍵を登録"],
          ] as const
        ).map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            className="btn-outline theme-secondary"
            disabled={entries.length >= 32}
            onClick={() => {
              const id = crypto.randomUUID();
              setExpanded((old) => [...old, id]);
              onChange([...entries, { id, name: "", kind }]);
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );
}

export function CredentialPicker({
  options,
  value,
  disabled,
  onChange,
}: {
  options: CredentialOption[];
  value: string[];
  disabled: boolean;
  onChange: (ids: string[]) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    title = useId();
  const [draft, setDraft] = useState<string[]>([]),
    [busy, setBusy] = useState(false);
  const choices = [
    ...options,
    ...value
      .filter((id) => !options.some((c) => c.id === id))
      .map((id) => ({ id, name: "削除済み", kind: "env" as const })),
  ];
  return (
    <>
      <button
        type="button"
        className="btn-text theme-secondary btn-sm credential-trigger"
        aria-label="セッションのクレデンシャル"
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => {
          setDraft([...value]);
          dialog.current?.showModal();
        }}
      >
        クレデンシャル{value.length ? ` (${value.length})` : ""}
      </button>
      {createPortal(
        <dialog
          ref={dialog}
          className="model-dialog"
          aria-labelledby={title}
          onCancel={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <div className="model-dialog-body">
            <header className="model-dialog-header">
              <h2 id={title}>クレデンシャルを選択</h2>
            </header>
            <div className="d-grid gap-2">
              {choices.map((entry) => (
                <label key={entry.id} className="settings-check">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={draft.includes(entry.id)}
                    onChange={(e) =>
                      setDraft((old) =>
                        e.target.checked
                          ? [...old, entry.id]
                          : old.filter((id) => id !== entry.id),
                      )
                    }
                  />
                  {entry.name}
                </label>
              ))}
              {!choices.length && (
                <p>設定からクレデンシャルを登録してください</p>
              )}
            </div>
            <div className="d-flex gap-2 mt-3">
              <button
                type="button"
                className="btn-solid theme-primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void onChange(draft)
                    .then((ok) => {
                      if (ok) dialog.current?.close();
                    })
                    .finally(() => setBusy(false));
                }}
              >
                適用
              </button>
              <button
                type="button"
                className="btn-text theme-secondary"
                disabled={busy}
                onClick={() => dialog.current?.close()}
              >
                キャンセル
              </button>
            </div>
          </div>
        </dialog>,
        document.body,
      )}
    </>
  );
}
