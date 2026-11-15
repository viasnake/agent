import type { ReactNode } from "react";
import { Icon } from "./icons.js";

export function SettingsToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="settings-toolbar d-flex flex-wrap gap-3 mb-5">
      {children}
    </div>
  );
}

export function SettingsDisclosure({
  title,
  status,
  open,
  onToggle,
  children,
}: {
  title: ReactNode;
  status?: ReactNode;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div className="accordion mb-5">
      <details
        className="accordion-item settings-disclosure"
        open={open}
        onToggle={(event) => onToggle(event.currentTarget.open)}
      >
        <summary className="accordion-header gap-4 p-5">
          <span className="flex-grow-1 min-w-0 text-break fw-semibold">
            {title}
          </span>
          {status && <small className="fg-2">{status}</small>}
          <span className="accordion-icon">
            <Icon name="chevron" />
          </span>
        </summary>
        {children}
      </details>
    </div>
  );
}

export function SettingsEmpty({ children }: { children: ReactNode }) {
  return <p className="card card-body p-5 mb-5 fg-2 text-center">{children}</p>;
}
