import { isAbsolute } from "node:path";
import { z } from "zod";
import type { BoundaryState } from "./branching.js";
import { AgentError } from "./types.js";
import { canonical, sha256 } from "./util.js";
import { secretPath } from "./workspace.js";

export const maxBoundaryBytes = 4 * 1024 * 1024;
export const maxBoundaryFiles = 10_000;
const strings = z.array(z.string());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const dataClass = z.enum(["public", "private", "restricted"]);
const runState = z.enum([
  "created",
  "planning",
  "running",
  "validating",
  "repairing",
  "waiting_input",
  "waiting_quota",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
]);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !/[\\\0]/.test(value) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== "..") &&
      !secretPath(value),
  );
const file = z.object({ path, hash, bytes: integer, mode: integer.max(0o777) });
const tree = z.object({
  origin: z.string().refine(isAbsolute).optional(),
  head: z.string().optional(),
  includeUntracked: z.boolean(),
  extraPaths: z.array(path).max(maxBoundaryFiles).optional(),
  baseline: z.array(file).max(maxBoundaryFiles),
  work: z.array(file).max(maxBoundaryFiles),
  redactedPaths: z.array(path).max(maxBoundaryFiles),
});
const note = z.object({
  id: z.string(),
  text: z.string(),
  kind: z.enum(["pin", "decision", "question"]),
  author: z.enum(["user", "host", "model"]),
  trusted: z.boolean(),
  updatedAt: integer,
});
const operation = z.object({
  id: z.string(),
  taskId: z.string(),
  name: z.string(),
  status: z.string(),
  argsHash: z.string(),
});
const work = z.object({
  checks: strings,
  hashes: z.record(z.string(), z.string()),
  artifacts: strings,
  operations: z.array(operation),
});
const context = z.object({
  pins: z.array(note),
  decisions: z.array(note),
  openQuestions: z.array(note),
  constraints: strings,
  instructions: z.array(
    z.object({
      seq: integer,
      role: z.string(),
      text: z.string(),
      runId: z.string().optional(),
    }),
  ),
  sourceIds: strings,
  imageIds: strings,
  originalRunIds: strings,
  redactedImageIds: strings.optional(),
  excludedSourceIds: strings.optional(),
  excludedSourceHashes: strings.optional(),
  excludedSourceUrls: strings.optional(),
  researchCheckpoint: z
    .object({
      summary: z.string(),
      searchedScopes: strings,
      openQuestions: strings,
      decisions: z.array(z.object({ text: z.string(), sourceIds: strings })),
      unavailableSourceIds: strings.optional(),
      author: z.literal("model"),
      trusted: z.literal(false),
      updatedAt: integer,
    })
    .optional(),
  workingState: work.extend({
    runId: z.string().optional(),
    status: z.string().optional(),
    history: z.array(
      work.extend({
        runId: z.string(),
        status: z.string(),
        results: z.array(
          z.object({
            role: z.string(),
            model: z.string().optional(),
            summary: z.string().optional(),
            unresolved: strings.optional(),
            author: z.literal("model"),
            trusted: z.literal(false),
          }),
        ),
      }),
    ),
  }),
  compactions: z.array(
    z.object({
      id: z.string(),
      archiveId: z.string(),
      at: integer,
      beforeBytes: integer,
      afterBytes: integer,
      trigger: z.enum(["automatic", "manual"]),
      heuristic: z.literal("bytes/3+images*8192"),
    }),
  ),
});
const image = z.object({
  id: z.string().regex(/^img-[a-f0-9]{64}$/),
  name: z.string(),
  mimeType: z.string(),
  width: integer,
  height: integer,
  editWidth: integer.optional(),
  editHeight: integer.optional(),
  bytes: integer,
  sha256: hash,
  dataClass,
  localOnly: z.boolean(),
  sourceId: z.string().optional(),
  documentId: z.string().optional(),
  transformation: z.string().optional(),
  comparisonOrder: integer.optional(),
});
const document = z.object({
  id: z.string().regex(/^doc-[a-f0-9]{64}$/),
  originalName: z.string(),
  format: z.string(),
  selector: z.string(),
  rawSha256: hash,
  selectedSha256: hash,
  rawBytes: integer,
  selectedBytes: integer,
  locator: z.string(),
  partial: z.boolean(),
  imageIds: strings.optional(),
});
const artifact = z.object({
  id: uuid,
  runId: uuid,
  name: z.string(),
  kind: z.enum([
    "document",
    "patch",
    "check",
    "source",
    "source-raw",
    "report",
  ]),
  sha256: hash,
  bytes: integer,
  dataClass,
  metadata: z.record(z.string(), z.unknown()),
});
const schema = z.object({
  version: z.literal(1),
  prefixDigest: hash.optional(),
  settings: z.object({
    name: z.string(),
    model: z.string().optional(),
    reviewer: z.string().optional(),
    strategy: z.enum(["single", "assisted", "reviewed"]),
    kind: z.enum(["auto", "chat", "coding", "writing", "research"]),
    dataClass,
    localOnly: z.boolean(),
    includeUntracked: z.boolean(),
    checks: strings,
    access: z.enum(["read-only", "change"]).optional(),
  }),
  context,
  images: z.array(image).max(8),
  evidenceImages: z.array(image).max(2000).optional(),
  preparedInputs: z.array(document).max(2000),
  artifacts: z
    .array(
      z.object({
        artifact,
        producer: z.object({
          id: uuid,
          state: runState,
          parentRunId: uuid.optional(),
        }),
        saveSeq: integer,
      }),
    )
    .max(2000),
  coding: tree.optional(),
  document: tree.optional(),
  codingRunId: uuid.optional(),
  documentRunId: uuid.optional(),
  policy: z.object({ dataClass, localOnly: z.boolean(), excluded: context }),
  unavailableReason: z.string().optional(),
});

export function decodeBoundary(
  raw: string,
  expectedHash?: string,
): BoundaryState {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > maxBoundaryBytes)
      throw new Error("size");
    const value: unknown = JSON.parse(raw);
    if (expectedHash && sha256(canonical(value)) !== expectedHash)
      throw new Error("hash");
    return schema.parse(value);
  } catch {
    throw new AgentError(
      "FORK_CORRUPT",
      "保存状態の形式・サイズ・ハッシュが不正です。会話本文のみの分岐は利用できます。",
    );
  }
}

export function validateBoundaryTree(value: unknown, maxBytes: number) {
  const result = tree.safeParse(value);
  if (!result.success)
    throw new AgentError("FORK_CORRUPT", "Saved workspace manifest is invalid");
  for (const files of [result.data.baseline, result.data.work]) {
    const paths = new Set(files.map((entry) => entry.path));
    if (
      paths.size !== files.length ||
      files.reduce((sum, entry) => sum + entry.bytes, 0) > maxBytes
    )
      throw new AgentError("FORK_SIZE", "Saved workspace exceeds its limits");
    for (const entry of files) {
      const components = entry.path.split("/");
      while (components.length > 1) {
        components.pop();
        if (paths.has(components.join("/")))
          throw new AgentError("FORK_CORRUPT", "Saved file paths overlap");
      }
    }
  }
  return result.data;
}
