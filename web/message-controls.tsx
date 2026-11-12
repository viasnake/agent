import { createContext, useContext, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import {
  AuiConfig,
  AuiProvider,
  BranchPickerPrimitive,
  SelectionToolbarPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import type { ClientOutput } from "@assistant-ui/store";
import { resource } from "@assistant-ui/tap";
import type { Conversation } from "./api.js";
import { MessageActions } from "./message-actions.js";
import type { MessageAction } from "./message-actions.js";
import { Icon } from "./icons.js";
import { useNotify } from "./notifications.js";

export const SessionBranches = createContext<{
  current: Conversation | null;
  sessions: Conversation[];
  onSelect: (id: string) => void;
}>({ current: null, sessions: [], onSelect: () => {} });

// These clients adapt only the controls. Pi owns history and branch creation;
// assistant-ui must never edit its local message repository in their place.
const ControlThread = resource(
  (client: ClientOutput<"thread">): ClientOutput<"thread"> => client,
);
const ControlMessage = resource(
  (client: ClientOutput<"message">): ClientOutput<"message"> => client,
);
const ControlComposer = resource(
  (client: ClientOutput<"composer">): ClientOutput<"composer"> => client,
);

export function MessageControlScope({ children }: { children: ReactNode }) {
  const aui = useAui();
  const message = useAuiState((state) => state.message);
  const thread = useAuiState((state) => state.thread);
  const { disabled, onAction } = useContext(MessageActions);
  const state = useMemo(
    () => ({
      ...thread,
      isDisabled: disabled,
      capabilities: { ...thread.capabilities, edit: true, reload: true },
    }),
    [thread, disabled],
  );
  function open(kind: MessageAction["kind"]) {
    const entryId = Number(message.id.split("-")[0]);
    if (disabled || !Number.isFinite(entryId)) return;
    onAction({
      kind,
      entryId,
      text: message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
      images: message.parts.some((part) => part.type === "image"),
    });
  }
  return (
    <AuiProvider
      extends={aui}
      config={AuiConfig({
        thread: ControlThread({ ...aui.thread(), getState: () => state }),
        message: ControlMessage({
          ...aui.message(),
          getState: () => message,
          reload: () => open("regenerate"),
        }),
        composer: ControlComposer({
          ...aui.composer(),
          beginEdit: () => open("edit"),
        }),
      })}
    >
      {children}
    </AuiProvider>
  );
}

export function MessageBranches() {
  const aui = useAui();
  const message = useAuiState((state) => state.message);
  const thread = useAuiState((state) => state.thread);
  const { current, sessions, onSelect } = useContext(SessionBranches);
  const { disabled } = useContext(MessageActions);
  if (!current) return null;
  const entryId = Number(message.id.split("-")[0]);
  const groups: { parent: Conversation; choices: Conversation[] }[] = [];
  const sourceEntry = (session: Conversation) =>
    session.branchSource?.entryId ?? session.forkEntry;
  const children = sessions.filter(
    (session) =>
      session.parentId === current.id && sourceEntry(session) === entryId,
  );
  if (children.length)
    groups.push({ parent: current, choices: [current, ...children] });

  const parent = sessions.find((session) => session.id === current.parentId);
  if (parent) {
    const source = current.branchSource;
    const anchorLoaded =
      !thread.hasEarlier ||
      thread.messages.some(
        (item) => Number(item.id.split("-")[0]) === current.forkEntry,
      );
    // Older branches have only the inherited anchor. Never guess an edit target.
    const target =
      !source || source.mode === "fork"
        ? thread.messages.find(
            (item) => Number(item.id.split("-")[0]) === current.forkEntry,
          )
        : anchorLoaded
          ? thread.messages.find(
              (item) =>
                Number(item.id.split("-")[0]) > (current.forkEntry ?? 0) &&
                item.role === (source.mode === "edit" ? "user" : "assistant") &&
                (source.mode === "edit" ||
                  (item.content.some((part) => part.type === "text") &&
                    !item.content.some((part) => part.type === "tool-call"))),
            )
          : undefined;
    if (target?.id === message.id) {
      groups.push({
        parent,
        choices: [
          parent,
          ...sessions.filter(
            (session) =>
              session.parentId === parent.id &&
              sourceEntry(session) === sourceEntry(current),
          ),
        ],
      });
    }
  }
  return groups.map(({ parent, choices }) => {
    const index = choices.findIndex((session) => session.id === current.id);
    // The selected view can arrive before the refreshed session list.
    if (index < 0) return null;
    const state = {
      ...message,
      branchNumber: index + 1,
      branchCount: choices.length,
    };
    const threadState = {
      ...thread,
      capabilities: { ...thread.capabilities, switchToBranch: true },
    };
    return (
      <AuiProvider
        key={parent.id}
        extends={aui}
        config={AuiConfig({
          thread: ControlThread({
            ...aui.thread(),
            getState: () => threadState,
          }),
          message: ControlMessage({
            ...aui.message(),
            getState: () => state,
            switchToBranch: ({ position }) => {
              const next = choices[index + (position === "previous" ? -1 : 1)];
              if (!disabled && next) onSelect(next.id);
            },
          }),
        })}
      >
        <BranchPickerPrimitive.Root
          hideWhenSingleBranch
          className="branch-picker"
          role="group"
          aria-label={`${parent.title} の分岐`}
        >
          <BranchPickerPrimitive.Previous
            className="btn-text theme-secondary btn-sm icon-button"
            aria-label="前の分岐"
            title={choices[index - 1]?.title ?? "前の分岐"}
            disabled={disabled}
          >
            <Icon name="left" />
          </BranchPickerPrimitive.Previous>
          <span aria-live="polite">
            <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
          </span>
          <BranchPickerPrimitive.Next
            className="btn-text theme-secondary btn-sm icon-button"
            aria-label="次の分岐"
            title={choices[index + 1]?.title ?? "次の分岐"}
            disabled={disabled}
          >
            <Icon name="right" />
          </BranchPickerPrimitive.Next>
        </BranchPickerPrimitive.Root>
      </AuiProvider>
    );
  });
}

export function SelectionToolbar({ disabled }: { disabled: boolean }) {
  const aui = useAui();
  const quote = useAuiState((state) => state.thread.composer.quote);
  const notify = useNotify();
  // Store quotes as ordinary editable draft text so reloads and failed sends use
  // the same browser-local draft path as typed input, without hidden metadata.
  useEffect(() => {
    if (!quote) return;
    const composer = aui.thread().composer();
    const current = composer.getState().text;
    const text = `${current}${current ? "\n\n" : ""}${quote.text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")}\n\n`;
    composer.setQuote(undefined);
    if (text.length > 64000) {
      notify("入力の上限を超えています", true);
      return;
    }
    composer.setText(text);
    document.getElementById("message")?.focus({ preventScroll: true });
  }, [aui, quote, notify]);
  return (
    <SelectionToolbarPrimitive.Root
      className="selection-toolbar"
      role="toolbar"
      aria-label="選択したテキストの操作"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          window.getSelection()?.removeAllRanges();
          document.getElementById("message")?.focus({ preventScroll: true });
        }
      }}
    >
      <SelectionToolbarPrimitive.Quote
        className="btn-text theme-secondary btn-sm"
        disabled={disabled}
        title="選択範囲を引用して返信"
      >
        <Icon name="quote" />
        引用して返信
      </SelectionToolbarPrimitive.Quote>
    </SelectionToolbarPrimitive.Root>
  );
}
