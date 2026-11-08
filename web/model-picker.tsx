import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.js";

type Choice = { id: string; name: string; available?: boolean; group?: string };
export function ModelPicker({
  value,
  models,
  onChange,
  disabled,
  label,
  compact,
  onManage,
}: {
  value: string;
  models: Choice[];
  onChange: (id: string) => void;
  disabled?: boolean;
  label: string;
  compact?: boolean;
  onManage?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selected = models.find((m) => m.id === value);
  const choices = models.filter((m) =>
    `${m.name} ${m.group ?? "OpenAI"}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  function close() {
    dialog.current?.close();
  }
  return (
    <>
      <button
        type="button"
        className={`model-trigger ${compact ? "btn-text theme-secondary btn-sm" : "form-control"}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setQuery("");
          setOpen(true);
          dialog.current?.showModal();
        }}
      >
        <Icon name="agent" />
        <span>
          {selected?.name ?? (value ? "モデルを選び直す" : "モデルを選択")}
        </span>
        <Icon name="chevron" />
      </button>
      {createPortal(
        <dialog
          ref={dialog}
          className="model-dialog"
          aria-labelledby={heading}
          onClose={() => setOpen(false)}
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div className="model-dialog-body">
            <header className="model-dialog-header">
              <h2 id={heading}>モデルを選択</h2>
              <button
                type="button"
                className="btn-text theme-secondary btn-sm"
                aria-label="モデル選択を閉じる"
                onClick={close}
              >
                <Icon name="close" />
              </button>
            </header>
            <input
              autoFocus
              className="form-control model-search"
              type="search"
              aria-label="モデルを検索"
              placeholder="モデルを検索…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  dialog.current
                    ?.querySelector<HTMLButtonElement>(".model-option")
                    ?.focus();
                }
              }}
            />
            <div
              className="model-list"
              aria-label="モデル一覧"
              onKeyDown={(e) => {
                if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key))
                  return;
                const buttons = [
                  ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                    ".model-option",
                  ),
                ];
                const index = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                if (index < 0) return;
                e.preventDefault();
                const next =
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? buttons.length - 1
                      : (index +
                          (e.key === "ArrowDown" ? 1 : -1) +
                          buttons.length) %
                        buttons.length;
                buttons[next]?.focus();
              }}
            >
              {[...new Set(choices.map((m) => m.group ?? "OpenAI"))].map(
                (group) => (
                  <div key={group} role="group" aria-label={group}>
                    <div className="model-group">{group}</div>
                    {choices
                      .filter((m) => (m.group ?? "OpenAI") === group)
                      .map((m) => (
                        <button
                          type="button"
                          key={m.id}
                          className="model-option"
                          aria-pressed={m.id === value}
                          onClick={() => {
                            close();
                            onChange(m.id);
                          }}
                        >
                          <span className="model-option-icon">
                            <Icon name="agent" />
                          </span>
                          <span className="model-option-name">
                            {m.name}
                            {m.available === false && <small>未認証</small>}
                          </span>
                          {m.id === value && <Icon name="check" />}
                        </button>
                      ))}
                  </div>
                ),
              )}
              {!choices.length && (
                <p className="model-empty">
                  {models.length
                    ? "一致するモデルがありません"
                    : "選択できるモデルがありません"}
                </p>
              )}
            </div>
            {onManage && (
              <footer className="model-dialog-footer">
                <button
                  type="button"
                  className="btn-text theme-primary btn-sm"
                  onClick={() => {
                    close();
                    onManage();
                  }}
                >
                  <Icon name="plus" />
                  接続を管理
                </button>
              </footer>
            )}
          </div>
        </dialog>,
        document.body,
      )}
    </>
  );
}
