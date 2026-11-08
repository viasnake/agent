import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Icon } from "./icons.js";
type Notice = { id: number; message: string; error: boolean };
const Notifications = createContext<(message: string, error?: boolean) => void>(
  () => {},
);
export const useNotify = () => useContext(Notifications);
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<Notice>();
  const [paused, setPaused] = useState(false);
  const notify = useCallback((message: string, error = false) => {
    setNotice({ id: Date.now(), message, error });
  }, []);
  useEffect(() => {
    if (!notice || paused) return;
    const timer = setTimeout(
      () => setNotice(undefined),
      notice.error ? 8000 : 6000,
    );
    return () => clearTimeout(timer);
  }, [notice, paused]);
  return (
    <Notifications.Provider value={notify}>
      {children}
      <div className="notification-region" aria-label="通知">
        {notice && (
          <div
            key={notice.id}
            id={notice.error ? "error" : undefined}
            className={`notification alert ${notice.error ? "theme-danger" : "theme-success"}`}
            role={notice.error ? "alert" : "status"}
            onFocus={() => setPaused(true)}
            onBlur={() => setPaused(false)}
          >
            <span>{notice.message}</span>
            <button
              type="button"
              className="btn-text theme-secondary btn-sm"
              aria-label="通知を閉じる"
              onClick={() => {
                setNotice(undefined);
                setPaused(false);
              }}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
      </div>
    </Notifications.Provider>
  );
}
