import { createContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.js";

export type MessageAction = {
  kind: "fork" | "regenerate";
  entryId: number;
};
export const MessageActions = createContext<{
  disabled: boolean;
  activeEntry: number | null;
  onAction: (action: MessageAction) => void;
  onEdit?: (entryId: number, text: string) => Promise<void>;
  onRemember?: (entryId: number, text: string) => void;
}>({ disabled: true, activeEntry: null, onAction: () => {} });
export function MessageActionDialog({
  action,
  onClose,
  onSubmit,
}: {
  action: MessageAction;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const label = action.kind === "regenerate" ? "回答を再生成" : "ここから分岐";
  return createPortal(
    <dialog
      ref={dialog}
      className="session-dialog message-dialog"
      aria-labelledby={heading}
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || (action.kind === "regenerate" && !approved)) return;
          setBusy(true);
          setError("");
          try {
            await onSubmit();
            dialog.current?.close();
          } catch (error) {
            setError(
              error instanceof Error
                ? error.message
                : "操作を完了できませんでした",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 id={heading}>
          <Icon name={action.kind === "regenerate" ? "retry" : "fork"} />
          {label}
        </h2>
        <p>
          元の履歴を残し、新しいスレッドに分岐します。作業ファイルはコピーしません。
        </p>
        {action.kind !== "fork" && (
          <label className="settings-check">
            <input
              type="checkbox"
              className="form-check-input"
              checked={approved}
              disabled={busy}
              onChange={(event) => setApproved(event.target.checked)}
            />
            モデル・ツールの再実行を許可（利用枠・料金を消費）
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <footer>
          <button
            type="button"
            className="btn-outline theme-secondary"
            disabled={busy}
            onClick={() => dialog.current?.close()}
          >
            キャンセル
          </button>
          <button
            type="submit"
            className="btn-solid theme-primary"
            disabled={busy || (action.kind === "regenerate" && !approved)}
          >
            <Icon
              name={busy ? "more" : action.kind === "fork" ? "fork" : "send"}
            />
            {busy ? "処理中…" : label}
          </button>
        </footer>
      </form>
    </dialog>,
    document.body,
  );
}
