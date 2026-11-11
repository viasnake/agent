import { createContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons.js";

export type MessageAction = {
  kind: "fork" | "edit" | "regenerate";
  entryId: number;
  text: string;
  images: boolean;
};
export const MessageActions = createContext<{
  disabled: boolean;
  activeEntry: number | null;
  onAction: (action: MessageAction) => void;
  onRemember?: (entryId: number, text: string) => void;
}>({ disabled: true, activeEntry: null, onAction: () => {} });
export function MessageActionDialog({
  action,
  onClose,
  onSubmit,
}: {
  action: MessageAction;
  onClose: () => void;
  onSubmit: (text: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [text, setText] = useState(action.text);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const label =
    action.kind === "edit"
      ? "編集して送信"
      : action.kind === "regenerate"
        ? "回答を再生成"
        : "ここから分岐";
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
          if (
            busy ||
            (action.kind !== "fork" && !approved) ||
            (action.kind === "edit" && !text.trim())
          )
            return;
          setBusy(true);
          setError("");
          try {
            await onSubmit(text);
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
          <Icon
            name={
              action.kind === "edit"
                ? "edit"
                : action.kind === "regenerate"
                  ? "retry"
                  : "fork"
            }
          />
          {label}
        </h2>
        <p>
          元の履歴を残し、新しいセッションに分岐します。作業ファイルはコピーしません。
        </p>
        {action.kind === "edit" && (
          <>
            <textarea
              className="form-control"
              aria-label="メッセージを編集"
              rows={7}
              maxLength={64000}
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={busy}
              autoFocus
            />
            {action.images && (
              <span className="small fg-2">
                <Icon name="attach" />
                元の画像を保持
              </span>
            )}
          </>
        )}
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
            disabled={
              busy ||
              (action.kind !== "fork" && !approved) ||
              (action.kind === "edit" && !text.trim())
            }
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
