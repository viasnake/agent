import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { AgentError, type Artifact, type Run } from "./types.js";
import { readBoundedFile, safePath, sha256 } from "./util.js";
import { inventory, secretPath, type FileEntry } from "./workspace.js";
import type { Store } from "./storage.js";

export type SearchKind =
  "conversations" | "runs" | "messages" | "events" | "artifacts" | "files";

export interface SearchRequest {
  kind: SearchKind;
  text: string;
  conversationId?: string;
  runId?: string;
  cursor?: string;
}

export interface SearchHit {
  kind: SearchKind;
  conversationId: string;
  runId?: string;
  id: string;
  hash: string;
  label: string;
  excerpt: string;
  line?: number;
}

export interface SearchPage {
  hits: SearchHit[];
  cursor?: string;
  scanned: number;
  warnings: string[];
}

export interface SearchContext {
  store: Store;
  workspace: string;
  currentConversationId: string;
  currentWorkRunId?: string;
  maxWorkspaceBytes: number;
}

const maxHits = 30;
const maxCandidates = 100;
const maxContentBytes = 8 * 1024 * 1024;
const maxRecordBytes = 1 * 1024 * 1024;
const maxResultBytes = 32_000;
const maxExcerptChars = 500;
const deadlineMs = 5_000;
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hashPattern = /^[a-f0-9]{64}$/;
const kinds = new Set<SearchKind>([
  "conversations",
  "runs",
  "messages",
  "events",
  "artifacts",
  "files",
]);

interface CursorData {
  version: 1;
  kind: SearchKind;
  text: string;
  workspace: string;
  conversationId?: string;
  runId?: string;
  key: number | string;
  inventoryHash?: string;
}

interface Candidate {
  cursor: number | string;
  conversationId: string;
  runId?: string;
  id: string;
}

interface ScanState {
  started: number;
  contentBytes: number;
  scanned: number;
  last?: number | string;
  hits: SearchHit[];
  warnings: Set<string>;
  query: string;
  stopBefore?: boolean;
}

interface Match {
  found: boolean;
  line?: number;
  excerpt: string;
}

function fail(code: string, message: string): never {
  throw new AgentError(code, message);
}

function validId(value: unknown, name: string): string {
  if (typeof value !== "string" || !idPattern.test(value))
    fail("SEARCH_INPUT", `${name} must be a UUID`);
  return value;
}

function validateRequest(request: SearchRequest): SearchRequest {
  if (!request || typeof request !== "object" || !kinds.has(request.kind))
    fail("SEARCH_INPUT", "Unknown search kind");
  if (typeof request.text !== "string" || !request.text.trim())
    fail("SEARCH_INPUT", "Search text must not be empty");
  if ([...request.text].length > 500 || Buffer.byteLength(request.text) > 2_000)
    fail("SEARCH_INPUT", "Search text exceeds its limit");
  if (request.conversationId !== undefined)
    validId(request.conversationId, "conversationId");
  if (request.runId !== undefined) validId(request.runId, "runId");
  if (request.kind === "files") {
    if (!request.conversationId || !request.runId)
      fail("SEARCH_INPUT", "File search requires a conversation and run");
  } else if (request.runId !== undefined) {
    fail("SEARCH_INPUT", "runId is only valid for file search");
  }
  if (request.cursor !== undefined) {
    if (typeof request.cursor !== "string" || request.cursor.length > 4_096)
      fail("SEARCH_CURSOR", "Invalid search cursor");
  }
  return request;
}

function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): CursorData | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Partial<CursorData>;
    if (
      value.version !== 1 ||
      !kinds.has(value.kind as SearchKind) ||
      typeof value.text !== "string" ||
      typeof value.workspace !== "string" ||
      (typeof value.key !== "number" && typeof value.key !== "string")
    )
      throw new Error("cursor");
    return value as CursorData;
  } catch {
    fail("SEARCH_CURSOR", "Invalid search cursor");
  }
}

function checkCursor(
  cursor: CursorData | undefined,
  request: SearchRequest,
  context: SearchContext,
  inventoryHash?: string,
): number | string {
  if (!cursor) return 0;
  if (
    cursor.kind !== request.kind ||
    cursor.text !== request.text ||
    cursor.workspace !== context.workspace ||
    cursor.conversationId !== request.conversationId ||
    cursor.runId !== request.runId
  )
    fail("SEARCH_CURSOR", "Search cursor does not match this request");
  if (request.kind === "files" && cursor.inventoryHash !== inventoryHash)
    fail("SEARCH_STALE", "Working copy changed since this page was searched");
  if (
    (request.kind === "files" && typeof cursor.key !== "string") ||
    (request.kind !== "files" && typeof cursor.key !== "number")
  )
    fail("SEARCH_CURSOR", "Search cursor position does not match its domain");
  if (
    typeof cursor.key === "number" &&
    (!Number.isSafeInteger(cursor.key) || cursor.key < 0)
  )
    fail("SEARCH_CURSOR", "Invalid search cursor position");
  if (typeof cursor.key === "string" && (!cursor.key || secretPath(cursor.key)))
    fail("SEARCH_CURSOR", "Invalid search cursor path");
  return cursor.key;
}

function firstLine(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++)
    if (text.charCodeAt(index) === 10) line++;
  return line;
}

function excerpt(text: string, offset: number): string {
  const start = Math.max(0, text.lastIndexOf("\n", offset) + 1);
  const end = text.indexOf("\n", offset);
  return text
    .slice(start, end < 0 ? start + maxExcerptChars : end)
    .slice(0, maxExcerptChars);
}

function matchText(text: string, query: string): Match {
  const offset = text.indexOf(query);
  if (offset < 0) return { found: false, excerpt: "" };
  return {
    found: true,
    line: firstLine(text, offset),
    excerpt: excerpt(text, offset),
  };
}

function matchFields(
  query: string,
  name: string,
  body?: string,
): Match & { nameMatch: boolean } {
  const nameMatch = matchText(name, query);
  if (nameMatch.found)
    return { ...nameMatch, line: undefined, nameMatch: true };
  if (body !== undefined)
    return { ...matchText(body, query), nameMatch: false };
  return { found: false, excerpt: "", nameMatch: false };
}

function boundedText(value: string): string | undefined {
  if (Buffer.byteLength(value) > maxRecordBytes || value.includes("\0"))
    return undefined;
  try {
    const bytes = Buffer.from(value, "utf8");
    if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value)
      return undefined;
  } catch {
    return undefined;
  }
  return value;
}

function addWarning(state: ScanState, warning: string): void {
  state.warnings.add(warning);
}

function reserveContent(state: ScanState, bytes: number): boolean {
  if (bytes > maxRecordBytes) return false;
  if (bytes > maxContentBytes - state.contentBytes) {
    state.stopBefore = true;
    addWarning(
      state,
      "このページでは内容上限に達しました。続きを検索してください。",
    );
    return false;
  }
  state.contentBytes += bytes;
  return true;
}

function timedOut(state: ScanState): boolean {
  return (
    performance.now() - state.started >= deadlineMs ||
    state.contentBytes >= maxContentBytes
  );
}

async function yieldToCaller(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function assertConversation(
  context: SearchContext,
  conversationId: string,
): void {
  const row = context.store.db
    .prepare("SELECT workspace FROM conversations WHERE id=?")
    .get(conversationId) as { workspace: string } | undefined;
  if (!row || row.workspace !== context.workspace)
    fail("SEARCH_SCOPE", "Conversation is outside the current workspace");
}

function assertRun(
  context: SearchContext,
  conversationId: string,
  runId: string,
): void {
  assertConversation(context, conversationId);
  if (
    !context.store.db
      .prepare(
        "SELECT 1 FROM conversation_runs WHERE session_id=? AND run_id=?",
      )
      .get(conversationId, runId)
  )
    fail("SEARCH_SCOPE", "Run does not belong to this conversation");
}

function candidateRows(
  context: SearchContext,
  request: SearchRequest,
  after: number,
): Candidate[] {
  const scope = request.conversationId ?? null;
  const rows = (() => {
    switch (request.kind) {
      case "conversations":
        return context.store.db
          .prepare(
            "SELECT c.rowid AS cursor,c.id AS conversationId,c.id AS id FROM conversations c WHERE c.workspace=? AND (? IS NULL OR c.id=?) AND c.rowid>? ORDER BY c.rowid LIMIT 101",
          )
          .all(context.workspace, scope, scope, after);
      case "runs":
        return context.store.db
          .prepare(
            "SELECT r.rowid AS cursor,c.id AS conversationId,r.id AS runId,r.id AS id FROM runs r JOIN conversation_runs cr ON cr.run_id=r.id JOIN conversations c ON c.id=cr.session_id WHERE c.workspace=? AND (? IS NULL OR c.id=?) AND r.rowid>? ORDER BY r.rowid LIMIT 101",
          )
          .all(context.workspace, scope, scope, after);
      case "messages":
        return context.store.db
          .prepare(
            "SELECT m.seq AS cursor,c.id AS conversationId,m.run_id AS runId,CAST(m.seq AS TEXT) AS id FROM messages m JOIN conversations c ON c.id=m.session_id WHERE c.workspace=? AND (? IS NULL OR c.id=?) AND m.seq>? ORDER BY m.seq LIMIT 101",
          )
          .all(context.workspace, scope, scope, after);
      case "events":
        return context.store.db
          .prepare(
            "SELECT e.seq AS cursor,c.id AS conversationId,e.run_id AS runId,CAST(e.seq AS TEXT) AS id FROM events e JOIN conversation_runs cr ON cr.run_id=e.run_id JOIN conversations c ON c.id=cr.session_id WHERE c.workspace=? AND (? IS NULL OR c.id=?) AND e.seq>? ORDER BY e.seq LIMIT 101",
          )
          .all(context.workspace, scope, scope, after);
      case "artifacts":
        return context.store.db
          .prepare(
            "SELECT a.rowid AS cursor,c.id AS conversationId,a.run_id AS runId,a.id AS id FROM artifacts a JOIN conversation_runs cr ON cr.run_id=a.run_id JOIN conversations c ON c.id=cr.session_id WHERE c.workspace=? AND (? IS NULL OR c.id=?) AND a.rowid>? AND json_extract(a.payload,'$.kind') <> 'source-raw' ORDER BY a.rowid LIMIT 101",
          )
          .all(context.workspace, scope, scope, after);
      case "files":
        return [];
    }
  })() as Array<{
    cursor: number;
    conversationId: string;
    runId?: string;
    id: string;
  }>;
  return rows.map((row) => ({ ...row, cursor: Number(row.cursor) }));
}

function renderRun(run: Run): { name: string; text: string } {
  const text = [
    run.objective,
    ...run.tasks.flatMap((task) => [
      task.objective,
      task.result?.summary ?? "",
      ...(task.result?.unresolved ?? []),
    ]),
  ]
    .filter(Boolean)
    .join("\n");
  return { name: run.objective, text };
}

function renderEvent(type: string, detail: string): string {
  return `${type}\n${detail}`;
}

async function assertArtifactFile(context: SearchContext, artifact: Artifact) {
  try {
    const stat = await lstat(
      join(context.store.runDir(artifact.runId), "artifacts", artifact.sha256),
    );
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== artifact.bytes)
      fail("ARTIFACT_CORRUPT", `Artifact hash mismatch: ${artifact.id}`);
  } catch (error) {
    if (error instanceof AgentError) throw error;
    fail("ARTIFACT_CORRUPT", `Artifact hash mismatch: ${artifact.id}`);
  }
}

function fileFingerprint(files: Record<string, FileEntry>): string {
  return sha256(
    JSON.stringify(
      Object.entries(files)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([path, entry]) => [path, entry.hash, entry.mode, entry.bytes]),
    ),
  );
}

async function fileState(
  context: SearchContext,
  request: SearchRequest,
): Promise<{
  files: Record<string, FileEntry>;
  fingerprint: string;
  runId: string;
}> {
  const conversationId = validId(request.conversationId!, "conversationId");
  const runId = validId(request.runId!, "runId");
  if (conversationId !== context.currentConversationId)
    fail("SEARCH_SCOPE", "File search is limited to the current conversation");
  if (!context.currentWorkRunId || runId !== context.currentWorkRunId)
    fail("SEARCH_SCOPE", "File search is limited to the current work copy");
  assertRun(context, conversationId, runId);
  context.store.assertIdle(runId);
  const run = context.store.get(runId);
  if (run.workspace !== context.workspace)
    fail("SEARCH_SCOPE", "Working copy is outside the current workspace");
  const files = await inventory(
    join(context.store.runDir(runId), "work"),
    context.maxWorkspaceBytes,
  );
  return { files, fingerprint: fileFingerprint(files), runId };
}

async function artifactCandidate(
  context: SearchContext,
  candidate: Candidate,
  state: ScanState,
): Promise<SearchHit | undefined> {
  const row = context.store.db
    .prepare(
      "SELECT CASE WHEN length(CAST(payload AS BLOB))<=? THEN payload END AS payload,length(CAST(payload AS BLOB)) AS bytes FROM artifacts WHERE id=? AND run_id=?",
    )
    .get(
      maxRecordBytes,
      candidate.id,
      candidate.runId ?? fail("SEARCH_SCOPE", "Artifact has no owning run"),
    ) as { payload: string | null; bytes: number } | undefined;
  if (!row) return undefined;
  if (row.bytes > maxRecordBytes) {
    addWarning(state, "省略した大きな資料記録");
    return undefined;
  }
  if (row.payload === null) return undefined;
  const artifact = JSON.parse(row.payload) as Artifact;
  const nameMatch = matchText(artifact.name, state.query);
  let body: string | undefined;
  if (artifact.bytes > maxRecordBytes) {
    await assertArtifactFile(context, artifact);
    addWarning(state, `省略した大きな資料: ${artifact.name}`);
  } else if (!reserveContent(state, artifact.bytes)) {
    if (!nameMatch.found) return undefined;
    state.stopBefore = false;
    addWarning(state, `省略した資料内容: ${artifact.name}`);
  } else {
    try {
      const content = await readBoundedFile(
        join(
          context.store.runDir(artifact.runId),
          "artifacts",
          artifact.sha256,
        ),
        maxRecordBytes,
        { expectedBytes: artifact.bytes, expectedSha256: artifact.sha256 },
      );
      if (content.includes(0))
        addWarning(state, `省略したバイナリ資料: ${artifact.name}`);
      else {
        try {
          body = new TextDecoder("utf-8", { fatal: true }).decode(content);
        } catch {
          addWarning(state, `省略した非UTF-8資料: ${artifact.name}`);
        }
      }
    } catch {
      fail("ARTIFACT_CORRUPT", `Artifact hash mismatch: ${artifact.id}`);
    }
  }
  const match = matchFields(state.query, artifact.name, body);
  if (!match.found) return undefined;
  return {
    kind: "artifacts",
    conversationId: candidate.conversationId,
    runId: candidate.runId,
    id: artifact.id,
    hash: artifact.sha256,
    label: artifact.name,
    excerpt: match.excerpt || artifact.name.slice(0, maxExcerptChars),
    ...(match.line ? { line: match.line } : {}),
  };
}

async function fileCandidate(
  context: SearchContext,
  candidate: Candidate,
  state: ScanState,
  files: Record<string, FileEntry>,
): Promise<SearchHit | undefined> {
  const entry = files[candidate.id];
  if (!entry || secretPath(candidate.id)) return undefined;
  const nameMatch = matchText(candidate.id, state.query);
  const workRoot = join(context.store.runDir(candidate.runId!), "work");
  let path: string;
  try {
    path = await safePath(workRoot, candidate.id);
  } catch {
    fail(
      "SEARCH_STALE",
      `Working copy changed while searching: ${candidate.id}`,
    );
  }
  let body: string | undefined;
  if (entry.bytes > maxRecordBytes) {
    addWarning(state, `省略した大きなファイル: ${candidate.id}`);
  } else if (!reserveContent(state, entry.bytes)) {
    if (!nameMatch.found) return undefined;
    state.stopBefore = false;
    addWarning(state, `省略したファイル内容: ${candidate.id}`);
  } else {
    try {
      const content = await readBoundedFile(path, maxRecordBytes, {
        expectedBytes: entry.bytes,
        expectedSha256: entry.hash,
      });
      if (content.includes(0))
        addWarning(state, `省略したバイナリファイル: ${candidate.id}`);
      else {
        try {
          body = new TextDecoder("utf-8", { fatal: true }).decode(content);
        } catch {
          addWarning(state, `省略した非UTF-8ファイル: ${candidate.id}`);
        }
      }
    } catch {
      fail(
        "SEARCH_STALE",
        `Working copy changed while searching: ${candidate.id}`,
      );
    }
  }
  const match = matchFields(state.query, candidate.id, body);
  if (!match.found) return undefined;
  return {
    kind: "files",
    conversationId: candidate.conversationId,
    runId: candidate.runId,
    id: candidate.id,
    hash: entry.hash,
    label: candidate.id,
    excerpt: match.excerpt || candidate.id,
    ...(match.line ? { line: match.line } : {}),
  };
}

async function databaseCandidate(
  context: SearchContext,
  request: SearchRequest,
  candidate: Candidate,
  state: ScanState,
): Promise<SearchHit | undefined> {
  switch (request.kind) {
    case "conversations": {
      const row = context.store.db
        .prepare(
          "SELECT json_extract(payload,'$.name') AS name,length(CAST(json_extract(payload,'$.name') AS BLOB)) AS bytes FROM conversations WHERE id=? AND workspace=?",
        )
        .get(candidate.id, context.workspace) as
        { name: string | null; bytes: number | null } | undefined;
      if (!row) return undefined;
      if (row.bytes !== null && row.bytes > maxRecordBytes) {
        addWarning(state, "省略した大きな会話名");
        return undefined;
      }
      const name = row.name ?? candidate.id;
      if (!reserveContent(state, Buffer.byteLength(name))) return undefined;
      const match = matchText(name, state.query);
      if (!match.found) return undefined;
      return {
        kind: request.kind,
        conversationId: candidate.conversationId,
        id: candidate.id,
        hash: sha256(Buffer.from(name)),
        label: name,
        excerpt: match.excerpt,
      };
    }
    case "runs": {
      const row = context.store.db
        .prepare(
          "SELECT CASE WHEN length(CAST(payload AS BLOB))<=? THEN payload END AS payload,length(CAST(payload AS BLOB)) AS bytes FROM runs WHERE id=?",
        )
        .get(maxRecordBytes, candidate.id) as
        { payload: string | null; bytes: number } | undefined;
      if (!row) return undefined;
      if (row.bytes > maxRecordBytes) {
        addWarning(state, "省略した大きな依頼記録");
        return undefined;
      }
      if (row.bytes > maxContentBytes - state.contentBytes) {
        state.stopBefore = true;
        addWarning(
          state,
          "このページでは内容上限に達しました。続きを検索してください。",
        );
        return undefined;
      }
      if (row.payload === null) return undefined;
      const rendered = renderRun(JSON.parse(row.payload) as Run);
      const textBytes = Buffer.byteLength(rendered.text);
      if (textBytes > maxRecordBytes) {
        addWarning(state, "省略した大きな依頼記録");
        return undefined;
      }
      if (!reserveContent(state, textBytes)) return undefined;
      const match = matchText(rendered.text, state.query);
      if (!match.found) return undefined;
      return {
        kind: request.kind,
        conversationId: candidate.conversationId,
        runId: candidate.runId,
        id: candidate.id,
        hash: sha256(Buffer.from(rendered.text)),
        label: rendered.name || candidate.id,
        excerpt: match.excerpt,
        ...(match.line ? { line: match.line } : {}),
      };
    }
    case "messages": {
      const row = context.store.db
        .prepare(
          "SELECT role,run_id,length(CAST(text AS BLOB)) AS bytes,CASE WHEN length(CAST(text AS BLOB))<=? THEN text END AS text FROM messages WHERE seq=? AND session_id=?",
        )
        .get(maxRecordBytes, Number(candidate.id), candidate.conversationId) as
        | {
            role: string;
            run_id: string | null;
            bytes: number;
            text: string | null;
          }
        | undefined;
      if (!row) return undefined;
      if (row.bytes > maxRecordBytes) {
        addWarning(state, "省略した大きな会話本文");
        return undefined;
      }
      if (row.bytes > maxContentBytes - state.contentBytes) {
        state.stopBefore = true;
        addWarning(
          state,
          "このページでは内容上限に達しました。続きを検索してください。",
        );
        return undefined;
      }
      const text = row.text;
      if (text === null || boundedText(text) === undefined) {
        addWarning(state, "省略した会話本文");
        return undefined;
      }
      if (!reserveContent(state, row.bytes)) return undefined;
      const match = matchText(text, state.query);
      if (!match.found) return undefined;
      return {
        kind: request.kind,
        conversationId: candidate.conversationId,
        ...(candidate.runId ? { runId: candidate.runId } : {}),
        id: candidate.id,
        hash: sha256(Buffer.from(text)),
        label: row.role,
        excerpt: match.excerpt,
        ...(match.line ? { line: match.line } : {}),
      };
    }
    case "events": {
      const row = context.store.db
        .prepare(
          "SELECT e.type,e.run_id AS runId,length(CAST(e.detail AS BLOB)) AS bytes,CASE WHEN length(CAST(e.detail AS BLOB))<=? THEN e.detail END AS detail FROM events e JOIN conversation_runs cr ON cr.run_id=e.run_id JOIN conversations c ON c.id=cr.session_id WHERE e.seq=? AND c.id=? AND c.workspace=?",
        )
        .get(
          maxRecordBytes,
          Number(candidate.id),
          candidate.conversationId,
          context.workspace,
        ) as
        | { type: string; runId: string; bytes: number; detail: string | null }
        | undefined;
      if (!row) return undefined;
      const totalBytes = row.bytes + Buffer.byteLength(row.type) + 1;
      if (totalBytes > maxRecordBytes) {
        addWarning(state, "省略した大きなイベント記録");
        return undefined;
      }
      if (totalBytes > maxContentBytes - state.contentBytes) {
        state.stopBefore = true;
        addWarning(
          state,
          "このページでは内容上限に達しました。続きを検索してください。",
        );
        return undefined;
      }
      if (row.detail === null) return undefined;
      const text = boundedText(renderEvent(row.type, row.detail));
      if (!text) {
        addWarning(state, "省略した大きなイベント記録");
        return undefined;
      }
      if (!reserveContent(state, Buffer.byteLength(text))) return undefined;
      const match = matchText(text, state.query);
      if (!match.found) return undefined;
      return {
        kind: request.kind,
        conversationId: candidate.conversationId,
        ...(candidate.runId ? { runId: candidate.runId } : {}),
        id: candidate.id,
        hash: sha256(Buffer.from(text)),
        label: row.type,
        excerpt: match.excerpt,
        ...(match.line ? { line: match.line } : {}),
      };
    }
    case "artifacts":
      return artifactCandidate(context, candidate, state);
    case "files":
      return undefined;
  }
}

async function scanDatabase(
  context: SearchContext,
  request: SearchRequest,
  after: number,
): Promise<SearchPage> {
  const state: ScanState = {
    started: performance.now(),
    contentBytes: 0,
    scanned: 0,
    hits: [],
    warnings: new Set(),
    query: request.text,
  };
  const rows = candidateRows(context, request, after);
  for (const row of rows.slice(0, maxCandidates)) {
    if (state.hits.length >= maxHits || timedOut(state)) break;
    await yieldToCaller();
    const hit = await databaseCandidate(context, request, row, state);
    if (state.stopBefore) break;
    state.scanned++;
    state.last = row.cursor;
    if (hit) state.hits.push(hit);
  }
  const hasRemaining =
    state.scanned < rows.length ||
    rows.length > maxCandidates ||
    timedOut(state);
  return {
    hits: state.hits,
    scanned: state.scanned,
    warnings: [...state.warnings],
    ...(hasRemaining && state.last !== undefined
      ? {
          cursor: encodeCursor({
            version: 1,
            kind: request.kind,
            text: request.text,
            workspace: context.workspace,
            conversationId: request.conversationId,
            runId: request.runId,
            key: state.last,
          }),
        }
      : {}),
  };
}

async function scanFiles(
  context: SearchContext,
  request: SearchRequest,
  state: Awaited<ReturnType<typeof fileState>>,
  after: number | string,
): Promise<SearchPage> {
  const scan: ScanState = {
    started: performance.now(),
    contentBytes: 0,
    scanned: 0,
    hits: [],
    warnings: new Set(),
    query: request.text,
  };
  const paths = Object.keys(state.files).sort();
  let start =
    typeof after === "string" ? paths.findIndex((path) => path > after) : 0;
  if (start < 0) start = paths.length;
  for (const path of paths.slice(start, start + maxCandidates)) {
    if (scan.hits.length >= maxHits || timedOut(scan)) break;
    await yieldToCaller();
    const hit = await fileCandidate(
      context,
      {
        cursor: path,
        conversationId: request.conversationId!,
        runId: state.runId,
        id: path,
      },
      scan,
      state.files,
    );
    if (scan.stopBefore) break;
    scan.scanned++;
    scan.last = path;
    if (hit) scan.hits.push(hit);
  }
  const index =
    typeof scan.last === "string" ? paths.indexOf(scan.last) + 1 : start;
  const more =
    index < paths.length ||
    scan.scanned < Math.min(maxCandidates, paths.length - start) ||
    timedOut(scan);
  return {
    hits: scan.hits,
    scanned: scan.scanned,
    warnings: [...scan.warnings],
    ...(more && scan.last !== undefined
      ? {
          cursor: encodeCursor({
            version: 1,
            kind: request.kind,
            text: request.text,
            workspace: context.workspace,
            conversationId: request.conversationId,
            runId: request.runId,
            key: scan.last,
            inventoryHash: state.fingerprint,
          }),
        }
      : {}),
  };
}

export async function searchLocal(
  context: SearchContext,
  rawRequest: SearchRequest,
): Promise<SearchPage> {
  const request = validateRequest(rawRequest);
  if (request.conversationId)
    assertConversation(context, request.conversationId);
  let fileContext: Awaited<ReturnType<typeof fileState>> | undefined;
  if (request.kind === "files") fileContext = await fileState(context, request);
  const cursor = decodeCursor(request.cursor);
  const after = checkCursor(cursor, request, context, fileContext?.fingerprint);
  if (request.kind === "files")
    return scanFiles(context, request, fileContext!, after);
  return scanDatabase(context, request, Number(after));
}

function boundedResult(text: string): string {
  if (Buffer.byteLength(text) <= maxResultBytes) return text;
  let result = text;
  while (Buffer.byteLength(result) > maxResultBytes - 80)
    result = result.slice(0, Math.max(0, result.length - 256));
  return `${result}\n\n[検索結果を${maxResultBytes}バイト以内に省略しました]`;
}

function assertHit(hit: SearchHit): SearchHit {
  if (!hit || typeof hit !== "object" || !kinds.has(hit.kind))
    fail("SEARCH_INPUT", "Invalid search result");
  validId(hit.conversationId, "conversationId");
  if (hit.runId !== undefined) validId(hit.runId, "runId");
  if (typeof hit.id !== "string" || !hit.id || hit.id.includes("\0"))
    fail("SEARCH_INPUT", "Invalid search result ID");
  if (
    (hit.kind === "messages" || hit.kind === "events") &&
    !/^\d+$/.test(hit.id)
  )
    fail("SEARCH_INPUT", "Invalid database search result ID");
  if (
    hit.kind === "files" &&
    (hit.id.startsWith("/") ||
      hit.id.split("/").some((part) => part === "." || part === "..") ||
      secretPath(hit.id))
  )
    fail("SEARCH_INPUT", "Invalid workspace search result path");
  if (hit.kind === "conversations" && hit.id !== hit.conversationId)
    fail("SEARCH_INPUT", "Conversation result ID does not match its owner");
  if (hit.kind === "runs" && hit.runId !== hit.id)
    fail("SEARCH_INPUT", "Run result ID does not match its owner");
  if (typeof hit.hash !== "string" || !hashPattern.test(hit.hash))
    fail("SEARCH_INPUT", "Invalid search result hash");
  return hit;
}

async function readArtifact(
  context: SearchContext,
  hit: SearchHit,
): Promise<{ title: string; text: string; hash: string }> {
  const row = context.store.db
    .prepare(
      "SELECT CASE WHEN length(CAST(a.payload AS BLOB))<=? THEN a.payload END AS payload,length(CAST(a.payload AS BLOB)) AS bytes,c.id AS conversationId FROM artifacts a JOIN conversation_runs cr ON cr.run_id=a.run_id JOIN conversations c ON c.id=cr.session_id WHERE a.id=? AND c.workspace=?",
    )
    .get(maxRecordBytes, hit.id, context.workspace) as
    | { payload: string | null; bytes: number; conversationId: string }
    | undefined;
  if (!row || row.conversationId !== hit.conversationId)
    fail("SEARCH_SCOPE", "Search result is outside the current workspace");
  if (row.bytes > maxRecordBytes || row.payload === null)
    fail("SEARCH_OMITTED", "Artifact record is too large");
  const artifact = JSON.parse(row.payload) as Artifact;
  if (artifact.kind === "source-raw")
    fail("SEARCH_SCOPE", "Raw source artifacts are not searchable");
  if (hit.runId !== undefined && hit.runId !== artifact.runId)
    fail(
      "SEARCH_STALE",
      "Artifact ownership changed since this result was found",
    );
  if (artifact.sha256 !== hit.hash)
    fail("SEARCH_STALE", "Search result hash no longer matches");
  if (artifact.bytes > maxRecordBytes) {
    await assertArtifactFile(context, artifact);
    return {
      title: artifact.name,
      text: "[検索結果を省略しました: 大きすぎる資料です]",
      hash: artifact.sha256,
    };
  }
  let content: Buffer;
  try {
    content = await readBoundedFile(
      join(context.store.runDir(artifact.runId), "artifacts", artifact.sha256),
      maxRecordBytes,
      { expectedBytes: artifact.bytes, expectedSha256: artifact.sha256 },
    );
  } catch {
    fail("ARTIFACT_CORRUPT", `Artifact hash mismatch: ${artifact.id}`);
  }
  if (content.includes(0))
    return {
      title: artifact.name,
      text: "[検索結果を省略しました: バイナリ資料です]",
      hash: artifact.sha256,
    };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    return {
      title: artifact.name,
      text: boundedResult(text),
      hash: artifact.sha256,
    };
  } catch {
    return {
      title: artifact.name,
      text: "[検索結果を省略しました: UTF-8ではない資料です]",
      hash: artifact.sha256,
    };
  }
}

export async function readSearchResultLocal(
  context: SearchContext,
  rawHit: SearchHit,
): Promise<{ title: string; text: string }> {
  const hit = assertHit(rawHit);
  assertConversation(context, hit.conversationId);
  if (hit.kind === "files") {
    if (hit.conversationId !== context.currentConversationId || !hit.runId)
      fail("SEARCH_SCOPE", "File results require the current conversation");
    if (!context.currentWorkRunId || hit.runId !== context.currentWorkRunId)
      fail("SEARCH_SCOPE", "File result is outside the current work copy");
    assertRun(context, hit.conversationId, hit.runId);
    context.store.assertIdle(hit.runId);
    const run = context.store.get(hit.runId);
    if (run.workspace !== context.workspace)
      fail("SEARCH_SCOPE", "Working copy is outside the current workspace");
    if (secretPath(hit.id))
      fail("PATH_DENIED", "Protected workspace paths are not searchable");
    const files = await inventory(
      join(context.store.runDir(hit.runId), "work"),
      context.maxWorkspaceBytes,
    );
    const entry = files[hit.id];
    if (!entry || entry.hash !== hit.hash)
      fail("SEARCH_STALE", "Working copy changed since this result was found");
    if (entry.bytes > maxRecordBytes)
      return {
        title: hit.id,
        text: "[検索結果を省略しました: 大きすぎるファイルです]",
      };
    let content: Buffer;
    try {
      const workRoot = join(context.store.runDir(hit.runId), "work");
      const path = await safePath(workRoot, hit.id);
      content = await readBoundedFile(path, maxRecordBytes, {
        expectedBytes: entry.bytes,
        expectedSha256: entry.hash,
      });
    } catch {
      fail("SEARCH_STALE", "Working copy changed while reading the result");
    }
    if (content.includes(0))
      return {
        title: hit.id,
        text: "[検索結果を省略しました: バイナリファイルです]",
      };
    try {
      return {
        title: hit.id,
        text: boundedResult(
          new TextDecoder("utf-8", { fatal: true }).decode(content),
        ),
      };
    } catch {
      return {
        title: hit.id,
        text: "[検索結果を省略しました: UTF-8ではないファイルです]",
      };
    }
  }
  if (hit.kind === "artifacts") {
    const result = await readArtifact(context, hit);
    return { title: result.title, text: result.text };
  }
  if (hit.kind === "conversations") {
    const row = context.store.db
      .prepare(
        "SELECT CASE WHEN length(CAST(payload AS BLOB))<=? THEN payload END AS payload,length(CAST(payload AS BLOB)) AS bytes FROM conversations WHERE id=? AND workspace=?",
      )
      .get(maxRecordBytes, hit.id, context.workspace) as
      { payload: string | null; bytes: number } | undefined;
    if (!row) fail("SEARCH_STALE", "Conversation no longer exists");
    if (row.bytes > maxRecordBytes || row.payload === null)
      fail("SEARCH_OMITTED", "Conversation is too large");
    const session = JSON.parse(row.payload) as { name?: string };
    const text = session.name ?? hit.id;
    if (sha256(Buffer.from(text)) !== hit.hash)
      fail("SEARCH_STALE", "Conversation changed since this result was found");
    return { title: text, text };
  }
  if (hit.kind === "runs") {
    const row = context.store.db
      .prepare(
        "SELECT CASE WHEN length(CAST(r.payload AS BLOB))<=? THEN r.payload END AS payload,length(CAST(r.payload AS BLOB)) AS bytes FROM runs r JOIN conversation_runs cr ON cr.run_id=r.id JOIN conversations c ON c.id=cr.session_id WHERE r.id=? AND c.id=? AND c.workspace=?",
      )
      .get(maxRecordBytes, hit.id, hit.conversationId, context.workspace) as
      { payload: string | null; bytes: number } | undefined;
    if (!row) fail("SEARCH_STALE", "Run no longer exists");
    if (row.bytes > maxRecordBytes || row.payload === null)
      fail("SEARCH_OMITTED", "Run is too large");
    if (hit.runId !== undefined && hit.runId !== hit.id)
      fail("SEARCH_STALE", "Run ownership changed since this result was found");
    const rendered = renderRun(JSON.parse(row.payload) as Run);
    if (sha256(Buffer.from(rendered.text)) !== hit.hash)
      fail("SEARCH_STALE", "Run changed since this result was found");
    return {
      title: rendered.name || hit.id,
      text: boundedResult(rendered.text),
    };
  }
  if (hit.kind === "messages") {
    const row = context.store.db
      .prepare(
        "SELECT role,CASE WHEN length(CAST(text AS BLOB))<=? THEN text END AS text,length(CAST(text AS BLOB)) AS bytes,run_id FROM messages WHERE seq=? AND session_id=?",
      )
      .get(maxRecordBytes, Number(hit.id), hit.conversationId) as
      | {
          role: string;
          text: string | null;
          bytes: number;
          run_id: string | null;
        }
      | undefined;
    if (!row) fail("SEARCH_STALE", "Message no longer exists");
    if (row.bytes > maxRecordBytes || row.text === null)
      fail("SEARCH_OMITTED", "Message is too large");
    if (hit.runId !== undefined && hit.runId !== row.run_id)
      fail(
        "SEARCH_STALE",
        "Message ownership changed since this result was found",
      );
    if (boundedText(row.text) === undefined)
      fail("SEARCH_OMITTED", "Message is too large or binary");
    if (sha256(Buffer.from(row.text)) !== hit.hash)
      fail("SEARCH_STALE", "Message changed since this result was found");
    return { title: row.role, text: boundedResult(row.text) };
  }
  const event = context.store.db
    .prepare(
      "SELECT e.type,CASE WHEN length(CAST(e.detail AS BLOB))<=? THEN e.detail END AS detail,length(CAST(e.detail AS BLOB)) AS bytes,e.run_id AS runId FROM events e JOIN conversation_runs cr ON cr.run_id=e.run_id JOIN conversations c ON c.id=cr.session_id WHERE e.seq=? AND c.id=? AND c.workspace=?",
    )
    .get(
      maxRecordBytes,
      Number(hit.id),
      hit.conversationId,
      context.workspace,
    ) as
    | { type: string; detail: string | null; bytes: number; runId: string }
    | undefined;
  if (!event) fail("SEARCH_STALE", "Event no longer exists");
  if (event.bytes > maxRecordBytes || event.detail === null)
    fail("SEARCH_OMITTED", "Event is too large");
  if (hit.runId !== undefined && hit.runId !== event.runId)
    fail("SEARCH_STALE", "Event ownership changed since this result was found");
  const text = renderEvent(event.type, event.detail);
  if (boundedText(text) === undefined)
    fail("SEARCH_OMITTED", "Event is too large or binary");
  if (sha256(Buffer.from(text)) !== hit.hash)
    fail("SEARCH_STALE", "Event changed since this result was found");
  return { title: event.type, text: boundedResult(text) };
}
