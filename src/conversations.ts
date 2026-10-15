import { Store } from "./storage.js";
import {
  AgentError,
  type DataClass,
  type ImageReference,
  type Run,
  type WorkKind,
} from "./types.js";
import { id } from "./util.js";

export interface PendingInput {
  id: string;
  text: string;
  mode: "instruction" | "next";
  runId?: string;
  images?: ImageReference[];
  previewBinding?: string;
  previewConfigHash?: string;
  previewDataClass?: DataClass;
  previewLocalOnly?: boolean;
  previewKind?: WorkKind;
  previewModel?: string;
  previewStrategy?: Run["mode"];
  previewReviewer?: string;
}
export interface Conversation {
  id: string;
  name: string;
  workspace: string;
  latestRunId?: string;
  workRunId?: string;
  documentRunId?: string;
  contextRunId?: string;
  appliedRunId?: string;
  draft: string;
  queue: PendingInput[];
  model?: string;
  reviewer?: string;
  strategy: Run["mode"];
  kind: WorkKind | "auto";
  checks: string[];
  dataClass: DataClass;
  localOnly: boolean;
  includeUntracked: boolean;
  compacted?: boolean;
  handoff?: string;
  images?: ImageReference[];
}
export interface ConversationMessage {
  seq: number;
  role: string;
  text: string;
  run_id: string | null;
  at: number;
}

// Model history belongs to Pi. This store contains user-visible messages and
// references to runs, never a second copy of model/tool conversation state.
export class Conversations {
  readonly owner = id();
  constructor(readonly store: Store) {}
  create(
    workspace: string,
    defaults: {
      dataClass: DataClass;
      checks: string[];
      strategy?: Run["mode"];
    },
  ): Conversation {
    const session: Conversation = {
      id: id(),
      name: "新しい会話",
      workspace,
      draft: "",
      queue: [],
      strategy: "single",
      kind: "auto",
      localOnly: false,
      includeUntracked: false,
      ...defaults,
    };
    this.store.db
      .prepare("INSERT INTO conversations VALUES (?,?,?,?,NULL,NULL)")
      .run(session.id, workspace, Date.now(), JSON.stringify(session));
    return this.acquire(session.id);
  }
  list(workspace: string, offset = 0): Conversation[] {
    return (
      this.store.db
        .prepare(
          "SELECT payload FROM conversations WHERE workspace=? ORDER BY updated_at DESC LIMIT 30 OFFSET ?",
        )
        .all(workspace, offset) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as Conversation);
  }
  get(sessionId: string): Conversation {
    const row = this.store.db
      .prepare("SELECT payload FROM conversations WHERE id=?")
      .get(sessionId) as { payload: string } | undefined;
    if (!row) throw new AgentError("SESSION", "Conversation not found");
    return JSON.parse(row.payload) as Conversation;
  }
  acquire(sessionId: string): Conversation {
    return this.store.transaction(() => {
      const row = this.store.db
        .prepare("SELECT payload,owner,heartbeat FROM conversations WHERE id=?")
        .get(sessionId) as
        | { payload: string; owner: string | null; heartbeat: number | null }
        | undefined;
      if (!row) throw new AgentError("SESSION", "Conversation not found");
      if (
        row.owner &&
        row.owner !== this.owner &&
        row.heartbeat &&
        Date.now() - row.heartbeat < 15000
      )
        throw new AgentError(
          "SESSION_BUSY",
          "Conversation is open in another process",
        );
      this.store.db
        .prepare("UPDATE conversations SET owner=?,heartbeat=? WHERE id=?")
        .run(this.owner, Date.now(), sessionId);
      return JSON.parse(row.payload) as Conversation;
    });
  }
  save(session: Conversation): void {
    const result = this.store.db
      .prepare(
        "UPDATE conversations SET payload=?,updated_at=?,heartbeat=? WHERE id=? AND owner=?",
      )
      .run(
        JSON.stringify(session),
        Date.now(),
        Date.now(),
        session.id,
        this.owner,
      );
    if (!result.changes)
      throw new AgentError("SESSION_BUSY", "Conversation ownership changed");
  }
  release(sessionId: string): void {
    this.store.db
      .prepare(
        "UPDATE conversations SET owner=NULL,heartbeat=NULL WHERE id=? AND owner=?",
      )
      .run(sessionId, this.owner);
  }
  message(
    session: Conversation,
    role: string,
    text: string,
    runId?: string,
  ): void {
    this.store.db
      .prepare(
        "INSERT INTO messages(session_id,role,text,run_id,at) VALUES (?,?,?,?,?)",
      )
      .run(session.id, role, text, runId ?? null, Date.now());
  }
  messages(
    sessionId: string,
    before = Number.MAX_SAFE_INTEGER,
  ): ConversationMessage[] {
    return (
      this.store.db
        .prepare(
          "SELECT seq,role,text,run_id,at FROM messages WHERE session_id=? AND seq<? ORDER BY seq DESC LIMIT 30",
        )
        .all(sessionId, before) as unknown as ConversationMessage[]
    ).reverse();
  }
  link(session: Conversation, run: Run): void {
    this.store.db
      .prepare("INSERT INTO conversation_runs VALUES (?,?)")
      .run(session.id, run.id);
  }
}
