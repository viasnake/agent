import { useEffect, useState } from "react";
import { api, type ModelOptions } from "./api.js";
import { SettingsDisclosure } from "./settings-layout.js";
import type { SettingsInput } from "../src/settings.js";

type AutoModel = NonNullable<SettingsInput["autoModel"]>;

export function AutoModelSettings({
  value,
  saved,
  models,
  onChange,
  revision,
}: {
  value?: AutoModel | null;
  saved?: AutoModel;
  models: SettingsInput["models"];
  onChange: (value: AutoModel | null) => void;
  revision: number;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ModelOptions>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setFailed(false);
    setOptions(undefined);
    void api<ModelOptions>("/api/model-options").then(
      (next) => {
        if (active) setOptions(next);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [open, revision, retry]);
  const connection = options?.models.find(
    (model) =>
      model.id === value?.connectionId &&
      model.provider === models.find((m) => m.id === model.id)?.provider,
  );
  const update = (patch: Partial<AutoModel>) => {
    if (value) onChange({ ...value, ...patch });
  };
  return (
    <SettingsDisclosure
      title="Auto"
      status={value ? "有効" : "無効"}
      open={open}
      onToggle={setOpen}
    >
      <div className="accordion-body settings-card settings-form-grid p-5 text-break">
        <label className="form-label d-block m-0 settings-span-all">
          モデル接続
          <select
            className="form-control mt-1"
            aria-label="モデル接続"
            value={value?.connectionId ?? ""}
            onChange={(event) => {
              const connectionId = event.currentTarget.value;
              onChange(
                connectionId
                  ? {
                      accountId: "",
                      ...value,
                      connectionId,
                      light: "",
                      standard: "",
                    }
                  : null,
              );
            }}
          >
            <option value="">使用しない</option>
            {models
              .filter(
                (model) =>
                  model.id === value?.connectionId ||
                  options?.models.some((m) => m.id === model.id && m.available),
              )
              .map((model) => (
                <option value={model.id} key={model.id}>
                  {model.name ||
                    options?.models.find((m) => m.id === model.id)?.name ||
                    model.provider}
                </option>
              ))}
          </select>
        </label>
        {failed || connection?.error ? (
          <div
            className="d-flex align-items-center gap-2 settings-span-all"
            role="status"
          >
            <span>{connection?.error ?? "モデル一覧を取得できません"}</span>
            <button
              className="btn-text theme-secondary"
              type="button"
              onClick={() => setRetry((value) => value + 1)}
            >
              再試行
            </button>
          </div>
        ) : !options && open ? (
          <span className="settings-span-all" role="status">
            モデル一覧を読み込み中
          </span>
        ) : null}
        {value && (
          <>
            {(
              [
                ["light", "軽量モデル"],
                ["standard", "標準モデル"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="form-label d-block m-0">
                {label}
                <select
                  className="form-control mt-1"
                  aria-label={label}
                  value={value[key]}
                  onChange={(event) =>
                    update({ [key]: event.currentTarget.value })
                  }
                >
                  <option value="">選択してください</option>
                  {!!value[key] &&
                    !connection?.catalog?.includes(value[key]) && (
                      <option value={value[key]}>{value[key]}（未確認）</option>
                    )}
                  {connection?.catalog?.map((model) => (
                    <option
                      key={model}
                      value={model}
                      disabled={
                        model === value[key === "light" ? "standard" : "light"]
                      }
                    >
                      {model}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label className="form-label d-block m-0">
              Cloudflare アカウント ID
              <input
                className="form-control mt-1"
                autoComplete="off"
                value={value.accountId}
                onChange={(event) =>
                  update({ accountId: event.currentTarget.value })
                }
              />
            </label>
            <label className="form-label d-block m-0">
              Workers AI トークン
              <input
                className="form-control mt-1"
                autoComplete="off"
                type="password"
                value={
                  value.token ??
                  (saved?.accountId === value.accountId ? saved.token : "") ??
                  ""
                }
                onChange={(event) =>
                  update({ token: event.currentTarget.value })
                }
              />
            </label>
            <p className="small fg-2 m-0 settings-span-all">
              Auto の判定に使用できる短い依頼文は Cloudflare Workers AI
              に送信されます。
            </p>
          </>
        )}
      </div>
    </SettingsDisclosure>
  );
}
