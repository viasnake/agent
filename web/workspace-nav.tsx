import { Icon } from "./icons.js";

export const workspaceViews = {
  home: { label: "ホーム", icon: "home" },
  inbox: { label: "受信箱", icon: "inbox" },
  board: { label: "掲示板", icon: "board" },
  documents: { label: "成果物", icon: "library" },
  activity: { label: "更新履歴", icon: "timeline" },
} as const;
export type WorkspaceView = keyof typeof workspaceViews;

export function workspaceView(query: URLSearchParams): WorkspaceView {
  const value = query.get("view") ?? query.get("projects");
  return value && Object.hasOwn(workspaceViews, value)
    ? (value as WorkspaceView)
    : "home";
}
export function WorkspaceNav({
  current,
  onOpen,
}: {
  current?: WorkspaceView;
  onOpen: (view: WorkspaceView) => void;
}) {
  return (
    <nav className="workspace-nav" aria-label="ワークスペース">
      {(Object.keys(workspaceViews) as WorkspaceView[]).map((view) => (
        <button
          type="button"
          className="portal-tab"
          key={view}
          title={workspaceViews[view].label}
          aria-label={workspaceViews[view].label}
          aria-current={view === current ? "page" : undefined}
          onClick={() => onOpen(view)}
        >
          <Icon name={workspaceViews[view].icon} />
          <span className="portal-tab-label">{workspaceViews[view].label}</span>
        </button>
      ))}
    </nav>
  );
}
