import { SettingsDisclosure, SettingsEmpty } from "./settings-layout.js";
import { useRef } from "react";
import type { WorkCredentialInput } from "../src/work-credentials.js";
import type { WorkCredential } from "../src/work-credentials.js";

type Row = { name: string; value?: string };
export function CredentialSettings({
  expanded,
  onToggle,
  entries,
  saved,
  environments,
  onEnvironments,
  onChange,
  onError,
}: {
  expanded: Set<string>;
  onToggle: (id: string, open: boolean) => void;
  entries: WorkCredentialInput[];
  saved: WorkCredential[];
  environments: Record<string, Row[]>;
  onEnvironments: (id: string, rows: Row[]) => void;
  onChange: (entries: WorkCredentialInput[]) => void;
  onError: (message: string) => void;
}) {
  const latest = useRef(entries);
  latest.current = entries;
  return (
    <>
      {!entries.length && (
        <SettingsEmpty>クレデンシャルはありません</SettingsEmpty>
      )}
      {entries.map((entry) => {
        const current = saved.find((c) => c.id === entry.id);
        const update = (next: WorkCredentialInput) =>
          onChange(entries.map((c) => (c.id === entry.id ? next : c)));
        const rows: Row[] =
          environments[entry.id] ??
          (current?.kind === "env"
            ? Object.entries(current.env).map(([name, value]) => ({
                name,
                value,
              }))
            : []);
        return (
          <SettingsDisclosure
            key={entry.id}
            title={entry.name || "新しいクレデンシャル"}
            status={entry.kind === "env" ? "環境変数" : "SSH 鍵"}
            open={expanded.has(entry.id)}
            onToggle={(open) => onToggle(entry.id, open)}
          >
            <div className="accordion-body settings-card d-flex flex-column gap-4 p-5 text-break">
              <fieldset className="settings-form-section">
                <legend>登録情報</legend>
                <label className="form-label d-block m-0">
                  名前
                  <input
                    className="form-control mt-1"
                    value={entry.name}
                    maxLength={100}
                    onChange={(e) => update({ ...entry, name: e.target.value })}
                  />
                </label>
              </fieldset>
              <fieldset className="settings-form-section">
                <legend>{entry.kind === "env" ? "環境変数" : "SSH 鍵"}</legend>
                {entry.kind === "env" ? (
                  <div className="environment-fields">
                    {rows.map((row, index) => (
                      <div className="environment-row" key={index}>
                        <input
                          className="form-control mt-1"
                          aria-label={`環境変数名 ${index + 1}`}
                          placeholder="GH_TOKEN"
                          value={row.name}
                          onChange={(e) =>
                            onEnvironments(
                              entry.id,
                              rows.map((r, i) =>
                                i === index
                                  ? {
                                      name: e.target.value,
                                      value: r.value ?? "",
                                    }
                                  : r,
                              ),
                            )
                          }
                        />
                        <input
                          className="form-control mt-1"
                          type="text"
                          autoComplete="new-password"
                          aria-label={`環境変数の値 ${index + 1}`}
                          placeholder={"値"}
                          value={row.value ?? ""}
                          onChange={(e) =>
                            onEnvironments(
                              entry.id,
                              rows.map((r, i) =>
                                i === index
                                  ? { ...r, value: e.target.value }
                                  : r,
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
                  <div className="settings-form-grid">
                    {!current && (
                      <label className="settings-check settings-span-all">
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
                    <label className="form-label d-block m-0 settings-span-all">
                      秘密鍵（パスフレーズなし）
                      <textarea
                        className="form-control mt-1"
                        aria-label="秘密鍵（パスフレーズなし）"
                        disabled={!!entry.generateKey}
                        rows={5}
                        autoComplete="off"
                        spellCheck={false}
                        value={
                          entry.privateKey ??
                          (current?.kind === "ssh" ? current.privateKey : "")
                        }
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
                    <label className="form-label d-block m-0 settings-span-all">
                      鍵ファイル
                      <input
                        type="file"
                        disabled={!!entry.generateKey}
                        className="form-control mt-1"
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
                    {current?.kind === "ssh" && current.publicKey && (
                      <label className="form-label d-block m-0 settings-span-all">
                        公開鍵
                        <textarea
                          className="form-control mt-1"
                          aria-label="公開鍵"
                          readOnly
                          rows={3}
                          value={current.publicKey}
                          onFocus={(e) => e.target.select()}
                        />
                      </label>
                    )}
                  </div>
                )}
              </fieldset>
              <div className="d-flex border-top pt-4 mt-1">
                <button
                  type="button"
                  className="btn-text theme-danger ms-auto"
                  onClick={() =>
                    onChange(entries.filter((c) => c.id !== entry.id))
                  }
                >
                  クレデンシャルを削除
                </button>
              </div>
            </div>
          </SettingsDisclosure>
        );
      })}
    </>
  );
}
