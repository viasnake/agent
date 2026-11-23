import { autoRoutingLimits } from "../src/model-routing-policy.js";
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
                      fallback: "",
                      rules: [],
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
            <label className="form-label d-block m-0 settings-span-all">
              既定モデル
              <AutoModelSelect
                label="既定モデル"
                value={value.fallback}
                catalog={connection?.catalog}
                onChange={(fallback) => update({ fallback })}
              />
            </label>
            <fieldset className="settings-form-section settings-span-all">
              <legend>振り分けルール</legend>
              <div className="d-flex flex-column gap-4">
                {value.rules.map((rule, index) => {
                  const label = `ルール ${index + 1}`;
                  const patchRule = (patch: Partial<typeof rule>) =>
                    update({
                      rules: value.rules.map((item) =>
                        item.id === rule.id ? { ...item, ...patch } : item,
                      ),
                    });
                  return (
                    <div
                      key={rule.id}
                      role="group"
                      aria-label={label}
                      className="settings-form-grid border rounded p-3"
                    >
                      <label className="form-label d-block m-0">
                        使う条件
                        <textarea
                          className="form-control mt-1"
                          rows={2}
                          maxLength={autoRoutingLimits.condition}
                          placeholder="例：短い翻訳・文章の整形"
                          value={rule.condition}
                          onChange={(event) =>
                            patchRule({ condition: event.currentTarget.value })
                          }
                        />
                      </label>
                      <label className="form-label d-block m-0">
                        使用モデル
                        <AutoModelSelect
                          label="使用モデル"
                          value={rule.model}
                          catalog={connection?.catalog}
                          onChange={(model) => patchRule({ model })}
                        />
                      </label>
                      <div className="settings-span-all d-flex justify-content-end">
                        <button
                          className="btn-text theme-danger"
                          type="button"
                          aria-label={`${label}を削除`}
                          onClick={() =>
                            update({
                              rules: value.rules.filter(
                                (item) => item.id !== rule.id,
                              ),
                            })
                          }
                        >
                          削除
                        </button>
                      </div>
                    </div>
                  );
                })}
                <div>
                  <button
                    className="btn-text theme-primary"
                    type="button"
                    disabled={value.rules.length >= autoRoutingLimits.rules}
                    onClick={() =>
                      update({
                        rules: [
                          ...value.rules,
                          { id: crypto.randomUUID(), condition: "", model: "" },
                        ],
                      })
                    }
                  >
                    ルールを追加
                  </button>
                </div>
              </div>
            </fieldset>
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
              Auto の判定では、短い依頼文とルールの条件を Cloudflare Workers AI
              に送信します。
            </p>
          </>
        )}
      </div>
    </SettingsDisclosure>
  );
}

function AutoModelSelect({
  label,
  value,
  catalog,
  onChange,
}: {
  label: string;
  value: string;
  catalog?: string[];
  onChange: (value: string) => void;
}) {
  return (
    <select
      className="form-control mt-1"
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      <option value="">選択してください</option>
      {!!value && !catalog?.includes(value) && (
        <option value={value}>{value}（未確認）</option>
      )}
      {catalog?.map((model) => (
        <option key={model} value={model}>
          {model}
        </option>
      ))}
    </select>
  );
}
