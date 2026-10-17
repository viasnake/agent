import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Paths } from "./config.js";
import {
  AgentError,
  terminalStates,
  type Artifact,
  type ModelUsage,
  type Run,
  type RunState,
} from "./types.js";
import { atomicWrite, canonical, id, sha256 } from "./util.js";

interface RunRow {
  payload: string;
  generation: number;
  heartbeat: number | null;
  cancel_requested: number;
}
export interface Operation {
  id: string;
  task_id: string;
  name: string;
  status: string;
  args_hash: string;
  result: string | null;
}
export interface UsageSummary {
  requests: number;
  knownCostUsd: number;
  unknownCostRequests: number;
  heldUsd: number;
  input: number | null;
  output: number | null;
  usageComplete: boolean;
}
export interface RequestReservation {
  id: string;
  connection: string;
  model: string;
  reservedUsd: number;
  costUsd: number | null;
  status: string;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly paths: Paths) {
    if (existsSync(paths.database)) {
      const stat = lstatSync(paths.database);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
        throw new AgentError(
          "UNSAFE_STORAGE",
          "Database must be a private regular file",
        );
    }
    this.db = new DatabaseSync(paths.database);
    chmodSync(paths.database, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;",
    );
    const version = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version.user_version > 3)
      throw new AgentError(
        "SCHEMA_VERSION",
        "Database was created by a newer agent",
      );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0, heartbeat INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        at INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL, task_id TEXT NOT NULL, name TEXT NOT NULL,
        args_hash TEXT NOT NULL, status TEXT NOT NULL, result TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        connection TEXT NOT NULL, model TEXT NOT NULL, quota_scope TEXT NOT NULL, at INTEGER NOT NULL,
        reserved_usd REAL NOT NULL, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER,
        status TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS cooldowns (connection TEXT PRIMARY KEY, until_ms INTEGER NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS requests_connection_time ON requests(quota_scope, at);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
    `);
    if (version.user_version > 0 && version.user_version < 3) {
      const backup = `${paths.database}.v${version.user_version}-${id()}.bak`;
      this.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
      chmodSync(backup, 0o600);
    }
    this.transaction(() =>
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, updated_at INTEGER NOT NULL,
        payload TEXT NOT NULL, owner TEXT, heartbeat INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS conversation_runs (
        session_id TEXT NOT NULL REFERENCES conversations(id),
        run_id TEXT UNIQUE NOT NULL REFERENCES runs(id), PRIMARY KEY(session_id, run_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL, text TEXT NOT NULL, run_id TEXT REFERENCES runs(id), at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_links (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        PRIMARY KEY(run_id, artifact_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS conversations_workspace ON conversations(workspace, updated_at);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
      CREATE TABLE IF NOT EXISTS boundaries (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES conversations(id),
        message_seq INTEGER NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL,
        state_available INTEGER NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS message_boundaries (
        session_id TEXT NOT NULL REFERENCES conversations(id),
        message_seq INTEGER NOT NULL, boundary_id TEXT NOT NULL REFERENCES boundaries(id),
        PRIMARY KEY(session_id, message_seq)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS boundary_artifacts (
        boundary_id TEXT NOT NULL REFERENCES boundaries(id) ON DELETE CASCADE,
        artifact_id TEXT NOT NULL REFERENCES artifacts(id),
        PRIMARY KEY(boundary_id, artifact_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS fork_lineages (
        child_session_id TEXT PRIMARY KEY REFERENCES conversations(id),
        parent_session_id TEXT NOT NULL REFERENCES conversations(id),
        source_message_seq INTEGER NOT NULL, mode TEXT NOT NULL,
        checkpoint_id TEXT, policy_floor TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS boundaries_session_seq ON boundaries(session_id, message_seq);
      PRAGMA user_version=3;
    `),
    );
  }
  close(): void {
    this.db.close();
  }
  saveBoundary(record: {
    id: string;
    sessionId: string;
    messageSeq: number;
    hash: string;
    payload: string;
    stateAvailable: boolean;
    artifactIds: string[];
  }): void {
    this.db
      .prepare("INSERT INTO boundaries VALUES (?,?,?,?,?,?,?)")
      .run(
        record.id,
        record.sessionId,
        record.messageSeq,
        record.hash,
        record.payload,
        record.stateAvailable ? 1 : 0,
        Date.now(),
      );
    this.db
      .prepare("INSERT INTO message_boundaries VALUES (?,?,?)")
      .run(record.sessionId, record.messageSeq, record.id);
    for (const artifactId of record.artifactIds)
      this.db
        .prepare("INSERT INTO boundary_artifacts VALUES (?,?)")
        .run(record.id, artifactId);
  }
  linkBoundary(
    sessionId: string,
    messageSeq: number,
    boundaryId: string,
  ): void {
    this.db
      .prepare("INSERT INTO message_boundaries VALUES (?,?,?)")
      .run(sessionId, messageSeq, boundaryId);
  }
  boundary(sessionId: string, messageSeq: number) {
    return this.db
      .prepare(
        "SELECT b.id,b.session_id,mb.message_seq,b.hash,CASE WHEN length(CAST(b.payload AS BLOB))<=4194304 THEN b.payload ELSE '' END AS payload,b.state_available,b.created_at FROM boundaries b JOIN message_boundaries mb ON mb.boundary_id=b.id WHERE mb.session_id=? AND mb.message_seq=?",
      )
      .get(sessionId, messageSeq) as
      | {
          id: string;
          session_id: string;
          message_seq: number;
          hash: string;
          payload: string;
          state_available: number;
          created_at: number;
        }
      | undefined;
  }
  boundaryById(boundaryId: string) {
    return this.db
      .prepare(
        "SELECT id,session_id,message_seq,hash,CASE WHEN length(CAST(payload AS BLOB))<=4194304 THEN payload ELSE '' END AS payload,state_available,created_at FROM boundaries WHERE id=?",
      )
      .get(boundaryId) as
      | {
          id: string;
          session_id: string;
          message_seq: number;
          hash: string;
          payload: string;
          state_available: number;
          created_at: number;
        }
      | undefined;
  }
  boundaries(sessionId: string, before = Number.MAX_SAFE_INTEGER, limit = 30) {
    return this.db
      .prepare(
        "SELECT b.id,b.session_id,mb.message_seq,b.hash,CASE WHEN length(CAST(b.payload AS BLOB))<=4194304 THEN b.payload ELSE '' END AS payload,b.state_available,b.created_at FROM boundaries b JOIN message_boundaries mb ON mb.boundary_id=b.id WHERE mb.session_id=? AND mb.message_seq<? ORDER BY mb.message_seq DESC LIMIT ?",
      )
      .all(sessionId, before, limit) as Array<{
      id: string;
      session_id: string;
      message_seq: number;
      hash: string;
      payload: string;
      state_available: number;
      created_at: number;
    }>;
  }
  setLineage(value: {
    childSessionId: string;
    parentSessionId: string;
    sourceMessageSeq: number;
    mode: "state" | "history";
    checkpointId?: string;
    policyFloor: string;
  }): void {
    this.db
      .prepare("INSERT INTO fork_lineages VALUES (?,?,?,?,?,?,?)")
      .run(
        value.childSessionId,
        value.parentSessionId,
        value.sourceMessageSeq,
        value.mode,
        value.checkpointId ?? null,
        value.policyFloor,
        Date.now(),
      );
  }
  lineage(sessionId: string) {
    return this.db
      .prepare("SELECT * FROM fork_lineages WHERE child_session_id=?")
      .get(sessionId) as
      | {
          child_session_id: string;
          parent_session_id: string;
          source_message_seq: number;
          mode: "state" | "history";
          checkpoint_id: string | null;
          policy_floor: string;
          created_at: number;
        }
      | undefined;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  event(
    runId: string,
    type: string,
    detail: Record<string, unknown> = {},
  ): void {
    this.db
      .prepare("INSERT INTO events(run_id,at,type,detail) VALUES (?,?,?,?)")
      .run(runId, Date.now(), type, canonical(detail));
  }
  create(run: Run): void {
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO runs(id,state,payload) VALUES (?,?,?)")
        .run(run.id, run.state, JSON.stringify(run));
      this.event(run.id, "run_created", {
        kind: run.kind,
        mode: run.mode,
        dataClass: run.dataClass,
      });
    });
  }
  get(runId: string): Run {
    const row = this.db
      .prepare("SELECT payload,generation FROM runs WHERE id=?")
      .get(runId) as unknown as RunRow | undefined;
    if (!row) throw new AgentError("NOT_FOUND", `Unknown run: ${runId}`);
    const run = JSON.parse(row.payload) as Run;
    return {
      ...run,
      access: run.access ?? (run.kind === "chat" ? "read-only" : "change"),
      generation: row.generation,
    };
  }
  list(limit: number | null = 100): Run[] {
    return (
      this.db
        .prepare("SELECT id FROM runs ORDER BY rowid DESC LIMIT ?")
        .all(limit ?? -1) as { id: string }[]
    ).map((r) => this.get(r.id));
  }
  assertLease(runId: string, generation: number): void {
    const row = this.db
      .prepare(
        "SELECT generation,heartbeat,cancel_requested FROM runs WHERE id=?",
      )
      .get(runId) as unknown as RunRow | undefined;
    if (!row || row.generation !== generation || row.heartbeat === null)
      throw new AgentError(
        "STALE_ATTEMPT",
        "This run is owned by another process or has been released",
      );
  }
  claim(
    runId: string,
    allowSucceeded = false,
    reconcileTerminal = false,
    beforeClaim?: (run: Run) => void,
  ): Run {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM runs WHERE id=?")
        .get(runId) as unknown as RunRow | undefined;
      const run = this.get(runId);
      beforeClaim?.(run);
      if (
        terminalStates.includes(run.state) &&
        !(allowSucceeded && run.state === "succeeded") &&
        !reconcileTerminal
      )
        throw new AgentError("TERMINAL_RUN", `Cannot resume ${run.state} run`);
      if (row?.heartbeat && Date.now() - row.heartbeat < 15000)
        throw new AgentError(
          "RUN_BUSY",
          "Run has a live lease; wait at least 15 seconds after a process crash",
        );
      this.db
        .prepare(
          "UPDATE operations SET status='unknown' WHERE run_id=? AND status='dispatched'",
        )
        .run(runId);
      this.db
        .prepare(
          "UPDATE operations SET status='failed',result='Not dispatched before interruption' WHERE run_id=? AND status='prepared'",
        )
        .run(runId);
      // A lost response may still have incurred a charge. Keep its reservation consumed.
      this.db
        .prepare(
          "UPDATE requests SET status='unknown' WHERE run_id=? AND status='reserved'",
        )
        .run(runId);
      run.generation++;
      for (const task of run.tasks)
        if (task.state === "running") task.state = "pending";
      this.db
        .prepare(
          "UPDATE runs SET generation=?,heartbeat=?,payload=? WHERE id=?",
        )
        .run(run.generation, Date.now(), JSON.stringify(run), runId);
      this.event(runId, "run_claimed", { generation: run.generation });
      return run;
    });
  }
  heartbeat(run: Run): boolean {
    this.assertLease(run.id, run.generation);
    this.db
      .prepare(
        "UPDATE runs SET heartbeat=?,payload=? WHERE id=? AND generation=?",
      )
      .run(Date.now(), JSON.stringify(run), run.id, run.generation);
    return this.cancelRequested(run.id);
  }
  save(
    run: Run,
    event = "run_updated",
    detail: Record<string, unknown> = {},
    commit?: () => void,
  ): void {
    this.transaction(() => {
      this.assertLease(run.id, run.generation);
      commit?.();
      this.saveInTransaction(run, event, detail);
    });
  }
  saveInTransaction(
    run: Run,
    event = "run_updated",
    detail: Record<string, unknown> = {},
  ): void {
    this.assertLease(run.id, run.generation);
    run.updatedAt = Date.now();
    this.db
      .prepare("UPDATE runs SET state=?,payload=? WHERE id=? AND generation=?")
      .run(run.state, JSON.stringify(run), run.id, run.generation);
    this.event(run.id, event, detail);
  }
  transition(run: Run, state: RunState, reason?: string): void {
    if (terminalStates.includes(run.state) && run.state !== state)
      throw new AgentError("STATE", "Cannot change a terminal run");
    const previous = run.state;
    run.state = state;
    run.reason = reason;
    this.save(run, "state_changed", { from: previous, to: state, reason });
  }
  release(run: Run): void {
    this.db
      .prepare("UPDATE runs SET heartbeat=NULL WHERE id=? AND generation=?")
      .run(run.id, run.generation);
  }
  assertIdle(runId: string): void {
    const row = this.db
      .prepare("SELECT heartbeat FROM runs WHERE id=?")
      .get(runId) as { heartbeat: number | null } | undefined;
    if (!row) throw new AgentError("NOT_FOUND", "Run not found");
    if (row.heartbeat !== null && Date.now() - row.heartbeat < 15000)
      throw new AgentError("RUN_BUSY", "Run is still owned by a live process");
  }
  inheritSources(
    parentId: string,
    runId: string,
    directOnly = false,
    excludeGit = false,
    excludeIds: readonly string[] = [],
    excludeHashes: readonly string[] = [],
    excludeUrls: readonly string[] = [],
  ): void {
    const sources = directOnly
      ? (
          this.db
            .prepare(
              "SELECT payload FROM artifacts WHERE run_id=? ORDER BY rowid",
            )
            .all(parentId) as { payload: string }[]
        ).map((row) => JSON.parse(row.payload) as Artifact)
      : this.artifacts(parentId);
    const authorized = sources.filter(
      (artifact) =>
        artifact.kind === "source" &&
        !(excludeGit && artifact.metadata.format === "git"),
    );
    const excludedIdSet = new Set(excludeIds),
      excludedHashSet = new Set(excludeHashes),
      excludedUrlSet = new Set(excludeUrls);
    const filtered = authorized.filter(
      (artifact) =>
        !excludedIdSet.has(artifact.id) &&
        !excludedHashSet.has(artifact.sha256) &&
        !excludedHashSet.has(String(artifact.metadata.rawSha256 ?? "")) &&
        !excludedHashSet.has(String(artifact.metadata.selectedSha256 ?? "")) &&
        !excludedUrlSet.has(String(artifact.metadata.url ?? "")) &&
        !excludedUrlSet.has(String(artifact.metadata.requestedUrl ?? "")),
    );
    const rawIds = new Set(
      filtered
        .map((artifact) => artifact.metadata.rawArtifactId)
        .filter((value): value is string => typeof value === "string"),
    );
    for (const source of sources.filter(
      (artifact) =>
        (artifact.kind === "source" ||
          (artifact.kind === "source-raw" && rawIds.has(artifact.id))) &&
        (artifact.kind !== "source" ||
          filtered.some((candidate) => candidate.id === artifact.id)),
    ))
      this.db
        .prepare("INSERT OR IGNORE INTO source_links VALUES (?,?)")
        .run(runId, source.id);
  }
  cancelRequested(runId: string): boolean {
    return !!(
      this.db
        .prepare("SELECT cancel_requested FROM runs WHERE id=?")
        .get(runId) as { cancel_requested: number } | undefined
    )?.cancel_requested;
  }
  cancel(runId: string): void {
    this.transaction(() => {
      const run = this.get(runId);
      if (terminalStates.includes(run.state)) return;
      this.db
        .prepare("UPDATE runs SET cancel_requested=1 WHERE id=?")
        .run(runId);
      this.event(runId, "cancel_requested");
    });
  }
  prepare(run: Run, taskId: string, name: string, args: unknown): string {
    return this.transaction(() => {
      this.assertLease(run.id, run.generation);
      if (this.cancelRequested(run.id))
        throw new AgentError("CANCELLED", "Cancellation requested");
      const operationId = id();
      this.db
        .prepare("INSERT INTO operations VALUES (?,?,?,?,?,?,?,NULL)")
        .run(
          operationId,
          run.id,
          run.generation,
          taskId,
          name,
          sha256(canonical(args)),
          "prepared",
        );
      this.event(run.id, "operation_prepared", { operationId, taskId, name });
      return operationId;
    });
  }
  operation(
    run: Run,
    operationId: string,
    status: "dispatched" | "completed" | "failed" | "unknown",
    result?: string,
  ): void {
    this.transaction(() => {
      this.assertLease(run.id, run.generation);
      const changed = this.db
        .prepare(
          "UPDATE operations SET status=?,result=? WHERE id=? AND run_id=? AND generation=?",
        )
        .run(status, result ?? null, operationId, run.id, run.generation);
      if (!changed.changes)
        throw new AgentError(
          "STALE_OPERATION",
          "Operation does not belong to this attempt",
        );
      this.event(run.id, "operation_" + status, { operationId });
    });
  }
  operations(runId: string): Operation[] {
    return this.db
      .prepare(
        "SELECT id,task_id,name,status,args_hash,result FROM operations WHERE run_id=?",
      )
      .all(runId) as unknown as Operation[];
  }
  reconcile(
    run: Run,
    operationId: string,
    outcome: "completed" | "failed",
    reason: string,
  ): void {
    this.transaction(() => {
      this.assertLease(run.id, run.generation);
      const changed = this.db
        .prepare(
          "UPDATE operations SET status=?,result=? WHERE id=? AND run_id=? AND status='unknown'",
        )
        .run(outcome, reason, operationId, run.id);
      if (!changed.changes)
        throw new AgentError("OPERATION", "Unknown operation not found");
      this.event(run.id, "operation_reconciled", {
        operationId,
        outcome,
        reason,
      });
    });
  }
  reserve(
    run: Run,
    connection: string,
    model: string,
    usd: number,
    maxUsd: number,
    maxRequests: number,
    rpm: number,
    quotaScope = connection,
  ): string {
    return this.transaction(() => {
      this.assertLease(run.id, run.generation);
      if (this.cancelRequested(run.id))
        throw new AgentError("CANCELLED", "Cancellation requested");
      const usage = this.usage(run.id);
      if (
        usage.requests >= maxRequests ||
        usage.knownCostUsd + usage.heldUsd + usd > maxUsd + 1e-9
      )
        throw new AgentError("BUDGET", "Run request or API budget exhausted");
      const cooldown = this.db
        .prepare("SELECT until_ms FROM cooldowns WHERE connection=?")
        .get(quotaScope) as { until_ms: number } | undefined;
      if (cooldown && cooldown.until_ms > Date.now())
        throw new AgentError(
          "QUOTA",
          `Connection ${connection} is cooling down until ${new Date(cooldown.until_ms).toISOString()}`,
        );
      const recent = this.db
        .prepare(
          "SELECT count(*) AS count FROM requests WHERE quota_scope=? AND at>?",
        )
        .get(quotaScope, Date.now() - 60000) as { count: number };
      if (recent.count >= rpm)
        throw new AgentError(
          "QUOTA",
          `Connection ${connection} reached its per-minute request limit`,
        );
      const requestId = id();
      this.db
        .prepare("INSERT INTO requests VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,?)")
        .run(
          requestId,
          run.id,
          connection,
          model,
          quotaScope,
          Date.now(),
          usd,
          "reserved",
        );
      this.event(run.id, "request_reserved", {
        requestId,
        connection,
        model,
        reservedUsd: usd,
      });
      return requestId;
    });
  }
  settle(run: Run, reservationId: string, usage: ModelUsage): void {
    for (const value of [usage.input, usage.output, usage.costUsd])
      if (value !== null && (!Number.isFinite(value) || value < 0))
        throw new AgentError(
          "USAGE",
          "Provider returned invalid usage; reservation retained",
        );
    this.transaction(() => {
      this.assertLease(run.id, run.generation);
      this.db
        .prepare(
          "UPDATE requests SET cost_usd=?,input_tokens=?,output_tokens=?,status='completed' WHERE id=? AND run_id=? AND status='reserved'",
        )
        .run(usage.costUsd, usage.input, usage.output, reservationId, run.id);
      this.event(run.id, "request_completed", { reservationId, ...usage });
    });
  }
  cooldown(connection: string, until: number): void {
    this.db
      .prepare(
        "INSERT INTO cooldowns VALUES (?,?) ON CONFLICT(connection) DO UPDATE SET until_ms=max(until_ms,excluded.until_ms)",
      )
      .run(connection, until);
  }
  usage(runId: string): UsageSummary {
    const row = this.db
      .prepare(
        `SELECT count(*) AS requests, coalesce(sum(cost_usd),0) AS knownCostUsd,
      coalesce(sum(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END),0) AS unknownCostRequests,
      coalesce(sum(CASE WHEN cost_usd IS NULL THEN reserved_usd ELSE 0 END),0) AS heldUsd,
      sum(input_tokens) AS input, sum(output_tokens) AS output,
      sum(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END) AS unknownInputRequests,
      sum(CASE WHEN output_tokens IS NULL THEN 1 ELSE 0 END) AS unknownOutputRequests,
      sum(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS unknownUsageRequests
      FROM requests WHERE run_id=?`,
      )
      .get(runId) as unknown as UsageSummary & {
      unknownUsageRequests: number;
      unknownInputRequests: number;
      unknownOutputRequests: number;
    };
    return {
      requests: row.requests,
      knownCostUsd: row.knownCostUsd,
      unknownCostRequests: row.unknownCostRequests,
      heldUsd: row.heldUsd,
      input: row.requests && !row.unknownInputRequests ? row.input : null,
      output: row.requests && !row.unknownOutputRequests ? row.output : null,
      usageComplete: Boolean(row.requests && !row.unknownUsageRequests),
    };
  }
  requestLedger(runId: string): RequestReservation[] {
    return this.db
      .prepare(
        "SELECT id,connection,model,reserved_usd AS reservedUsd,cost_usd AS costUsd,status FROM requests WHERE run_id=? ORDER BY at,id",
      )
      .all(runId) as unknown as RequestReservation[];
  }
  usageByConnection(runId: string): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare(
        `SELECT connection,model,count(*) AS requests,sum(input_tokens) AS inputTokens,
      sum(output_tokens) AS outputTokens,
      sum(CASE WHEN input_tokens IS NULL THEN 1 ELSE 0 END) AS unknownInputRequests,
      sum(CASE WHEN output_tokens IS NULL THEN 1 ELSE 0 END) AS unknownOutputRequests,
      sum(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS unknownUsageRequests,
      sum(cost_usd) AS knownCostUsd,
      sum(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unknownCostRequests,
      sum(CASE WHEN cost_usd IS NULL THEN reserved_usd ELSE 0 END) AS heldUsd
      FROM requests WHERE run_id=? GROUP BY connection,model`,
      )
      .all(runId) as unknown as Array<{
      connection: string;
      model: string;
      requests: number;
      inputTokens: number | null;
      outputTokens: number | null;
      unknownUsageRequests: number;
      unknownInputRequests: number;
      unknownOutputRequests: number;
      knownCostUsd: number | null;
      unknownCostRequests: number;
      heldUsd: number | null;
    }>;
    return rows.map((row) => ({
      ...row,
      inputTokens:
        row.requests && !row.unknownInputRequests ? row.inputTokens : null,
      outputTokens:
        row.requests && !row.unknownOutputRequests ? row.outputTokens : null,
      usageComplete: Boolean(row.requests && !row.unknownUsageRequests),
    }));
  }
  events(
    runId: string,
    after = 0,
  ): Array<{ seq: number; at: number; type: string; detail: string }> {
    return this.db
      .prepare(
        "SELECT seq,at,type,detail FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 1000",
      )
      .all(runId, after) as unknown as Array<{
      seq: number;
      at: number;
      type: string;
      detail: string;
    }>;
  }
  runDir(runId: string): string {
    this.get(runId);
    return join(this.paths.runs, runId);
  }
  async artifact(
    run: Run,
    name: string,
    kind: Artifact["kind"],
    content: string | Buffer,
    metadata: Record<string, unknown> = {},
    commit?: (artifact: Artifact) => void,
  ): Promise<Artifact> {
    this.assertLease(run.id, run.generation);
    const artifact: Artifact = {
      id: id(),
      runId: run.id,
      name,
      kind,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content),
      dataClass: run.dataClass,
      metadata,
    };
    await atomicWrite(
      join(this.runDir(run.id), "artifacts", artifact.sha256),
      content,
    );
    this.transaction(() => {
      this.assertLease(run.id, run.generation);
      this.db
        .prepare("INSERT INTO artifacts VALUES (?,?,?)")
        .run(artifact.id, run.id, JSON.stringify(artifact));
      this.event(run.id, "artifact_saved", {
        artifactId: artifact.id,
        name,
        kind,
        sha256: artifact.sha256,
      });
      commit?.(artifact);
    });
    return artifact;
  }
  artifacts(runId: string): Artifact[] {
    return (
      this.db
        .prepare(
          "SELECT payload FROM artifacts WHERE run_id=? OR id IN (SELECT artifact_id FROM source_links WHERE run_id=?) ORDER BY rowid",
        )
        .all(runId, runId) as { payload: string }[]
    ).map((a) => JSON.parse(a.payload) as Artifact);
  }
  async content(artifact: Artifact): Promise<Buffer> {
    const content = await readFile(
      join(this.runDir(artifact.runId), "artifacts", artifact.sha256),
    );
    if (sha256(content) !== artifact.sha256)
      throw new AgentError(
        "ARTIFACT_CORRUPT",
        `Artifact hash mismatch: ${artifact.id}`,
      );
    return content;
  }
  async remove(runId: string): Promise<void> {
    if (
      this.db
        .prepare("SELECT 1 FROM conversation_runs WHERE run_id=?")
        .get(runId) ||
      this.db
        .prepare(
          "SELECT 1 FROM source_links s JOIN artifacts a ON a.id=s.artifact_id WHERE a.run_id=?",
        )
        .get(runId) ||
      this.db
        .prepare(
          "SELECT 1 FROM boundary_artifacts ba JOIN artifacts a ON a.id=ba.artifact_id WHERE a.run_id=?",
        )
        .get(runId)
    )
      throw new AgentError(
        "SESSION_REFERENCE",
        "This run is retained by a conversation or source citation",
      );
    const run = this.transaction(() => {
      const run = this.get(runId);
      if (!terminalStates.includes(run.state))
        throw new AgentError("RUN_BUSY", "Only terminal runs can be removed");
      const row = this.db
        .prepare("SELECT heartbeat FROM runs WHERE id=?")
        .get(runId) as { heartbeat: number | null };
      if (row.heartbeat !== null && Date.now() - row.heartbeat < 15000)
        throw new AgentError("RUN_BUSY", "Run has an active operation lease");
      run.generation++;
      this.db
        .prepare("UPDATE runs SET generation=?,heartbeat=? WHERE id=?")
        .run(run.generation, Date.now(), runId);
      return run;
    });
    const heartbeat = setInterval(() => this.heartbeat(run), 1000);
    try {
      await rm(this.runDir(runId), { recursive: true, force: true });
      this.transaction(() => {
        this.assertLease(runId, run.generation);
        this.db.prepare("DELETE FROM runs WHERE id=?").run(runId);
      });
    } finally {
      clearInterval(heartbeat);
      this.release(run);
    }
  }
}
