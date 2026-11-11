import { SessionSearchResults } from "./search.js";
import type { MemorySource } from "./memory.js";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { Conversation } from "./api.js";
import { Icon } from "./icons.js";

type SessionAction = { session: Conversation; kind: "rename" | "delete" };
export function SessionList({
  sessions,
  selected,
  disabled,
  onSelect,
  onRename,
  onOpenSource,
  onDelete,
  onUpdate,
}: {
  sessions: Conversation[];
  selected: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
  onOpenSource: (source: MemorySource) => Promise<void>;
  onRename: (session: Conversation, title: string) => Promise<void>;
  onDelete: (session: Conversation) => Promise<void>;
  onUpdate: (
    session: Conversation,
    change: { pinned?: boolean; archived?: boolean },
  ) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [action, setAction] = useState<SessionAction | null>(null);
  const [target, setTarget] = useState<Conversation | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [menuVersion, setMenuVersion] = useState(0);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  useLayoutEffect(() => {
    if (!menuVersion || !target || !menu.current || !trigger.current) return;
    menu.current.showPopover();
    const anchor = trigger.current.getBoundingClientRect();
    const bounds = menu.current.getBoundingClientRect();
    setPosition({
      left: Math.max(
        8,
        Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 8),
      ),
      top: Math.max(
        8,
        Math.min(anchor.bottom + 6, innerHeight - bounds.height - 8),
      ),
    });
  }, [menuVersion, target]);
  const visible = useMemo(
    () =>
      sessions
        .filter(
          (session) =>
            (query.trim() || !!session.archived === archived) &&
            session.title
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase()),
        )
        .sort(
          (a, b) =>
            Number(!!b.pinned) - Number(!!a.pinned) ||
            b.updatedAt - a.updatedAt,
        ),
    [sessions, query, archived],
  );
  useEffect(() => {
    const close = () => menu.current?.hidePopover();
    window.addEventListener("resize", close);
    const list = document.getElementById("conversations");
    list?.addEventListener("scroll", close);
    return () => {
      window.removeEventListener("resize", close);
      list?.removeEventListener("scroll", close);
    };
  }, []);
  function choose(kind: SessionAction["kind"]) {
    menu.current?.hidePopover();
    if (target) setAction({ session: target, kind });
  }
  function group(time: number) {
    const date = new Date(time),
      today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    return date.toDateString() === today.toDateString()
      ? "今日"
      : date.toDateString() === yesterday.toDateString()
        ? "昨日"
        : "以前";
  }
  const groupLabel = (session: Conversation) =>
    session.pinned ? "ピン留め" : group(session.updatedAt);
  return (
    <>
      <div className="session-list-controls">
        <label className="session-search">
          <Icon name="search" />
          <input
            type="search"
            aria-label="セッションを検索"
            placeholder="セッションを検索"
            maxLength={200}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          className="btn-text theme-secondary btn-sm icon-button"
          aria-label={archived ? "通常のセッションを表示" : "アーカイブを表示"}
          title={archived ? "セッションに戻る" : "アーカイブ"}
          aria-pressed={archived}
          disabled={!!query.trim()}
          onClick={() => setArchived(!archived)}
        >
          <Icon name="archive" />
        </button>
      </div>
      <nav id="conversations" aria-label="セッション一覧">
        {!!query.trim() && <h2 className="sidebar-label">セッション名</h2>}
        {visible.map((session, index) => (
          <div key={session.id}>
            {!query.trim() &&
              (!index ||
                groupLabel(visible[index - 1]!) !== groupLabel(session)) && (
                <h2 className="sidebar-label">{groupLabel(session)}</h2>
              )}
            <div
              className={`session-row ${session.id === selected ? "selected" : ""}`}
              data-session-id={session.id}
            >
              <button
                className="conversation-item"
                aria-label={session.title}
                aria-current={session.id === selected ? "true" : undefined}
                title={session.title}
                disabled={disabled}
                onClick={() => onSelect(session.id)}
              >
                <Icon name={session.pinned ? "pin" : "chat"} />
                <span>{session.title}</span>
                {session.status !== "idle" && (
                  <span
                    className={`status-dot ${session.status}`}
                    aria-label={
                      session.status === "running" ? "実行中" : "中断"
                    }
                  />
                )}
              </button>
              <button
                className="session-more btn-text theme-secondary btn-sm icon-button"
                aria-label={`「${session.title}」の操作`}
                title="セッションの操作"
                aria-haspopup="dialog"
                aria-controls={menuId}
                disabled={disabled}
                onClick={(event) => {
                  trigger.current = event.currentTarget;
                  setTarget(session);
                  setMenuVersion((value) => value + 1);
                }}
              >
                <Icon name="more" />
              </button>
            </div>
          </div>
        ))}
        {!visible.length && (
          <p className="session-list-empty">
            {query
              ? "一致するセッション名はありません"
              : "セッションはありません"}
          </p>
        )}
        {!!query.trim() && (
          <SessionSearchResults
            query={query}
            onSelect={async (source) => {
              await onOpenSource(source);
              setQuery("");
            }}
          />
        )}
      </nav>
      {createPortal(
        <div
          ref={menu}
          id={menuId}
          popover="auto"
          role="dialog"
          aria-label="セッションの操作"
          className="session-popover"
          onToggle={(event) => {
            if (
              event.newState === "closed" &&
              document.activeElement === document.body
            )
              trigger.current?.focus({ preventScroll: true });
          }}
          style={position}
        >
          <button
            className="btn-text theme-secondary"
            autoFocus
            onClick={() => choose("rename")}
          >
            <Icon name="edit" />
            名前を変更
          </button>
          <button
            className="btn-text theme-secondary"
            onClick={() => {
              menu.current?.hidePopover();
              if (target) void onUpdate(target, { pinned: !target.pinned });
            }}
          >
            <Icon name="pin" />
            {target?.pinned ? "ピン留めを外す" : "ピン留め"}
          </button>
          <button
            className="btn-text theme-secondary"
            disabled={
              target?.status === "running" || target?.status === "stopping"
            }
            onClick={() => {
              menu.current?.hidePopover();
              if (target) void onUpdate(target, { archived: !target.archived });
            }}
          >
            <Icon name="archive" />
            {target?.archived ? "アーカイブから戻す" : "アーカイブ"}
          </button>
          <button
            className="btn-text theme-danger"
            disabled={
              target?.status === "running" || target?.status === "stopping"
            }
            onClick={() => choose("delete")}
          >
            <Icon name="trash" />
            セッションを削除
          </button>
          {target && (
            <a
              className="btn-text theme-secondary"
              href={`/api/conversations/${target.id}/export`}
              download
              onClick={() => menu.current?.hidePopover()}
            >
              <Icon name="down" />
              会話を保存
            </a>
          )}
        </div>,
        document.body,
      )}
      {action && (
        <SessionDialog
          action={action}
          onClose={() => {
            setAction(null);
            if (trigger.current?.isConnected)
              trigger.current.focus({ preventScroll: true });
            else
              document
                .getElementById("message")
                ?.focus({ preventScroll: true });
          }}
          onSubmit={(title) =>
            action.kind === "rename"
              ? onRename(action.session, title)
              : onDelete(action.session)
          }
        />
      )}
    </>
  );
}

function SessionDialog({
  action,
  onClose,
  onSubmit,
}: {
  action: SessionAction;
  onClose: () => void;
  onSubmit: (title: string) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(action.session.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const heading = useId();
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const deleting = action.kind === "delete";
  return createPortal(
    <dialog
      className="session-dialog"
      ref={dialog}
      aria-labelledby={heading}
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !title.trim()) return;
          setBusy(true);
          setError("");
          try {
            await onSubmit(title.trim());
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
        <h2 id={heading}>{deleting ? "セッションを削除" : "名前を変更"}</h2>
        {deleting ? (
          <>
            <p className="session-dialog-title">{action.session.title}</p>
            <p>
              削除後は開けなくなります。履歴と作業ファイルはディスクに残ります。
            </p>
          </>
        ) : (
          <label className="form-label">
            セッション名
            <input
              className="form-control"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              required
              autoFocus
              disabled={busy}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
        )}
        {error && (
          <p role="alert" className="fg-danger">
            {error}
          </p>
        )}
        <footer>
          <button
            type="button"
            className="btn-outline theme-secondary"
            autoFocus={deleting}
            disabled={busy}
            onClick={() => dialog.current?.close()}
          >
            キャンセル
          </button>
          <button
            type="submit"
            className={`btn-solid ${deleting ? "theme-danger" : "theme-primary"}`}
            disabled={busy || !title.trim()}
          >
            {busy ? "処理中…" : deleting ? "削除" : "保存"}
          </button>
        </footer>
      </form>
    </dialog>,
    document.body,
  );
}
