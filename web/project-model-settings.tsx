import { useEffect, useState } from "react";
import type { SettingsInput, ProjectModelSelection } from "../src/settings.js";
import { api, modelChoiceId, modelChoices, type ModelOptions } from "./api.js";
import { SettingsDisclosure } from "./settings-layout.js";

type Config = NonNullable<SettingsInput["projectModels"]>;

export function ProjectModelSettings({
  value,
  models,
  revision,
  onChange,
}: {
  value?: Config | null;
  models: SettingsInput["models"];
  revision: number;
  onChange: (config: Config) => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ModelOptions>();
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(false);
    setOptions(undefined);
    void api<ModelOptions>("/api/model-options").then(
      (result) => {
        if (current) setOptions(result);
      },
      () => {
        if (current) setError(true);
      },
    );
    return () => {
      current = false;
    };
  }, [open, revision, retry]);
  const config = value ?? { workers: [] };
  const choices = options
    ? modelChoices(options).filter((choice) =>
        models.some((m) => m.id === choice.connectionId),
      )
    : [];
  const id = (item: ProjectModelSelection) =>
    modelChoiceId(item.connectionId, item.model);
  function field(
    label: string,
    empty: string,
    selected: ProjectModelSelection | undefined,
    change: (item?: ProjectModelSelection) => void,
    excluded: ProjectModelSelection[] = [],
  ) {
    return (
      <label key={label} className="form-label d-block m-0">
        {label}
        <select
          aria-label={label}
          className="form-control mt-1"
          value={selected ? id(selected) : ""}
          disabled={!options}
          onChange={(event) => {
            const match = choices.find(
              (c) => c.id === event.currentTarget.value,
            );
            change(
              match && { connectionId: match.connectionId, model: match.model },
            );
          }}
        >
          <option value="">{empty}</option>
          {selected && !choices.some((c) => c.id === id(selected)) && (
            <option value={id(selected)}>{selected.model}（現在の設定）</option>
          )}
          {choices
            .filter((c) => !excluded.some((item) => id(item) === c.id))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.group} · {c.name}
              </option>
            ))}
        </select>
      </label>
    );
  }
  return (
    <SettingsDisclosure
      title="モデルの分担"
      open={open}
      onToggle={setOpen}
      status={
        config.workers.length || config.reviewer
          ? "個別指定"
          : "スレッドのモデルを使用"
      }
    >
      {open && (
        <div className="accordion-body settings-card d-grid gap-3 p-4">
          <p className="small fg-2 m-0">
            主担当はスレッドで選んだモデルです。作業はモデルの用途に合わせて分担します。
          </p>
          {error && (
            <button
              type="button"
              className="btn-text theme-secondary"
              onClick={() => setRetry((n) => n + 1)}
            >
              モデル一覧を再取得
            </button>
          )}
          {config.workers.map((worker, i) => (
            <div key={id(worker)} className="settings-form-grid">
              {field(
                "作業 " + (i + 1),
                "割り当てを外す",
                worker,
                (item) => {
                  const workers = [...config.workers];
                  workers.splice(
                    i,
                    1,
                    ...(item ? [{ ...item, specialty: worker.specialty }] : []),
                  );
                  onChange({ ...config, workers });
                },
                config.workers.filter((_, n) => n !== i),
              )}
              <label className="form-label m-0">
                用途（任意）
                <input
                  className="form-control mt-1"
                  maxLength={160}
                  placeholder="例：原因調査、再現テスト"
                  value={worker.specialty ?? ""}
                  onChange={(e) =>
                    onChange({
                      ...config,
                      workers: config.workers.map((w, n) =>
                        n === i ? { ...w, specialty: e.target.value } : w,
                      ),
                    })
                  }
                />
              </label>
            </div>
          ))}
          {config.workers.length < 4 &&
            field(
              config.workers.length ? "作業モデルを追加" : "作業",
              config.workers.length ? "選択…" : "主担当と同じ",
              undefined,
              (item) => {
                if (item)
                  onChange({ ...config, workers: [...config.workers, item] });
              },
              config.workers,
            )}
          {field("レビュー", "主担当と同じ", config.reviewer, (reviewer) =>
            onChange({ ...config, reviewer }),
          )}
        </div>
      )}
    </SettingsDisclosure>
  );
}
