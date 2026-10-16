import { EventEmitter } from "node:events";
import { realpath, readFile, lstat, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { stringify } from "yaml";
import lockfile from "proper-lockfile";
import { createTwoFilesPatch } from "diff";
import { applyRun } from "./artifacts.js";
import {
  configHash,
  loadConfig,
  validateConfig,
  type Config,
  type Paths,
} from "./config.js";
import {
  Conversations,
  type Conversation,
  type PendingInput,
} from "./conversations.js";
import { Harness } from "./harness.js";
import { Sandbox } from "./sandbox.js";
import { Store } from "./storage.js";
import {
  AgentError,
  terminalStates,
  type Run,
  type Runtime,
  type ImageReference,
  type DataClass,
  type RequestAccess,
  type ContextNote,
  type WorkKind,
  type DocumentReference,
  type PreparedInput,
  type Artifact,
  type ArtifactHistoryEntry,
  type ArtifactProvenance,
  type ArtifactProvenanceSourceRange,
  type ArtifactValidationCheck,
} from "./types.js";
import {
  compactContext,
  normalizeConversationContext,
  readContextArchive,
} from "./context.js";
import {
  atomicWrite,
  canonical,
  errorMessage,
  id,
  safePath,
  sha256,
} from "./util.js";
import {
  imageMimeForPath,
  isImageFileSignature,
  isImagePath,
  loadStoredImage,
  maxConversationImageBytes,
  maxConversationImages,
  readBoundedImage,
  saveImage,
  validateImage,
  validateImageReference,
  transformImage,
  mergeImageReferences,
} from "./images.js";
import { modelCandidates } from "./policy.js";
import { endpoint } from "./runtime/providers.js";
import { secretPath, workspaceDiff } from "./workspace.js";
import {
  loadPreparedInput,
  maxDocumentBytes,
  maxPreparedDocuments,
  maxPreparedInputBytes,
  parseDocumentToken,
  prepareDocument,
} from "./documents.js";
import { readClipboardPng } from "./clipboard.js";
import {
  readGitStatus,
  selectGitInput,
  storeGitInput,
  type GitInputSelection,
} from "./git-input.js";

export interface AppEvent {
  type: string;
  sessionId: string;
  runId?: string;
  detail: Record<string, unknown>;
}
export interface InputPreview {
  text: string;
  attachments: {
    path: string;
    bytes: number;
    mimeType?: string;
    id?: string;
    locator?: string;
    partial?: boolean;
  }[];
  documents: DocumentReference[];
  images: ImageReference[];
  destinations: string[];
  dataClass: DataClass;
  localOnly: boolean;
  access: RequestAccess;
  accessOverride?: RequestAccess;
}
interface InputSnapshot {
  text: string;
  attachments: InputPreview["attachments"];
  documents: DocumentReference[];
  images: ImageReference[];
  destinationBinding: string;
  configHash: string;
  dataClass: DataClass;
  localOnly: boolean;
  access: RequestAccess;
  accessOverride?: RequestAccess;
  kind: WorkKind;
  strategy: Run["mode"];
  model?: string;
  reviewer?: string;
}
const explicitReadOnly =
  /まだ(?:は)?変更しない|変更(?:は)?せず|変更(?:は)?しない|コードを変更しないで|修正せず|変更しないで|do not (?:change|modify|edit|write|implement)|don't (?:change|modify|edit|write|implement)|without (?:changing|modifying|editing|writing|implementing)|no (?:changes|edits|modifications)/i;
const exploratoryRequest =
  /\b(?:explain|review|plan|outline|describe|analy[sz]e|summari[sz]e|how to|how do i|what is|why does|suggest|recommend)\b|説明して|説明を|修正案|レビューして|レビュー|計画して|計画を|提案して/i;
export function inferAccess(
  text: string,
  previous: RequestAccess = "read-only",
): RequestAccess {
  if (explicitReadOnly.test(text) || exploratoryRequest.test(text))
    return "read-only";
  if (
    /実装して|修正して|変更して|作って|作成して|調査して|整文して|執筆して|追加して|削除して|直して|\b(?:fix|implement|refactor|add|remove|change|write|draft)\b/i.test(
      text,
    )
  )
    return "change";
  return previous === "change" &&
    /^(次に|続け|それ|これも|also\b|next\b|continue\b)/i.test(text)
    ? "change"
    : "read-only";
}
function effectiveAccess(
  text: string,
  previous: RequestAccess,
  override?: RequestAccess,
): RequestAccess {
  if (explicitReadOnly.test(text)) return "read-only";
  return override ?? inferAccess(text, previous);
}
function repositoryIntent(text: string): boolean {
  return /repo|repository|codebase|source|file|review|explain|plan|構成|リポジトリ|コード|ファイル|レビュー|説明|計画|調べ/i.test(
    text,
  );
}
export function inferKind(text: string, previous?: WorkKind): WorkKind {
  if (
    /まだ(?:は)?変更しない|変更せず|変更はしない|do not change|without changing|no changes/i.test(
      text,
    )
  )
    return "chat";
  if (/\b(research|sources|citations)\b|調査|出典|根拠付き/i.test(text))
    return "research";
  if (
    /\b(write|draft|translate|rewrite)\b.*\b(document|article|email|markdown|prose)\b|文書|記事|整文|翻訳|案内文|文章.*(作成|直|書)/i.test(
      text,
    )
  )
    return "writing";
  if (
    /\b(fix|implement|refactor|bug|add|remove|change|test)\b|修正|実装|改善|バグ|リファクタ|追加|削除|変更|テスト/i.test(
      text,
    )
  )
    return "coding";
  if (
    /^(次に|続け|それ|これも|also\b|next\b|continue\b)/i.test(text) &&
    previous
  )
    return previous;
  return "chat";
}
export function fileReferences(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/(?:^|\s)@(?:"([^"\n]+)"|([^\s]+))/g)].map(
        (m) => m[1] ?? m[2]!,
      ),
    ),
  ];
}

export class Application extends EventEmitter {
  readonly conversations: Conversations;
  session!: Conversation;
  busy = false;
  activeRunId?: string;
  private controller?: AbortController;
  private work?: Promise<void>;
  private generation = 0;
  private heartbeat?: NodeJS.Timeout;
  private closed = false;
  private readonly previews = new WeakMap<InputPreview, InputSnapshot>();
  private accessOverride?: RequestAccess;
  constructor(
    public config: Config,
    readonly paths: Paths,
    readonly store: Store,
    readonly workspace: string,
    readonly runtimeFactory: (config: Config) => Promise<Runtime> = async (
      config,
    ) => {
      const { PiRuntime } = await import("./runtime/pi.js");
      return new PiRuntime(config, paths);
    },
  ) {
    super();
    this.conversations = new Conversations(store);
  }
  async initialize(): Promise<void> {
    this.session = this.conversations.create(await realpath(this.workspace), {
      dataClass: this.config.defaults.dataClass,
      strategy: this.config.defaults.mode,
      checks: Object.keys(this.config.checks),
    });
    this.heartbeat = setInterval(() => {
      try {
        this.conversations.save(this.session);
      } catch (error) {
        this.stop();
        this.publish("notice", { text: errorMessage(error) });
      }
    }, 3000);
    this.heartbeat.unref();
    this.publish("changed");
  }
  private publish(
    type: string,
    detail: Record<string, unknown> = {},
    runId = this.activeRunId,
  ): void {
    this.emit("event", {
      type,
      detail,
      runId,
      sessionId: this.session.id,
    } satisfies AppEvent);
  }
  private idle(): void {
    if (this.busy)
      throw new AgentError(
        "BUSY",
        "実行中です。停止または完了後に操作してください。",
      );
  }
  save(): void {
    this.conversations.save(this.session);
    this.publish("changed");
  }
  setDraft(text: string): void {
    if (Buffer.byteLength(text) > this.config.limits.maxInputBytes) return;
    this.session.draft = text;
    this.conversations.save(this.session);
  }
  async newSession(): Promise<void> {
    this.idle();
    this.conversations.release(this.session.id);
    ++this.generation;
    this.session = this.conversations.create(this.session.workspace, {
      dataClass: this.config.defaults.dataClass,
      strategy: this.config.defaults.mode,
      checks: Object.keys(this.config.checks),
    });
    this.publish("session");
  }
  openSession(sessionId: string): void {
    this.idle();
    if (this.conversations.get(sessionId).workspace !== this.session.workspace)
      throw new AgentError(
        "SESSION",
        "現在の作業ディレクトリの会話を選択してください。",
      );
    const next = this.conversations.acquire(sessionId);
    this.conversations.release(
      this.session.id === sessionId ? "" : this.session.id,
    );
    this.session = next;
    ++this.generation;
    this.publish("session");
  }
  private effectiveDisclosure(images: ImageReference[]): {
    dataClass: DataClass;
    localOnly: boolean;
  } {
    const levels: DataClass[] = ["public", "private", "restricted"];
    const dataClass = images.reduce<DataClass>(
      (current, ref) =>
        levels.indexOf(ref.dataClass ?? "public") > levels.indexOf(current)
          ? (ref.dataClass ?? "public")
          : current,
      this.session.dataClass,
    );
    return {
      dataClass,
      localOnly:
        this.session.localOnly || images.some((ref) => ref.localOnly === true),
    };
  }
  private async snapshotInput(text: string): Promise<InputSnapshot> {
    let total = Buffer.byteLength(text);
    const attachments: InputPreview["attachments"] = [];
    const documents: DocumentReference[] = [];
    let rawDocumentBytes = 0;
    const fresh: ImageReference[] = [];
    const excludedIds = new Set(this.session.context?.excludedSourceIds ?? []);
    const excludedHashes = new Set(
      this.session.context?.excludedSourceHashes ?? [],
    );
    const tokens = fileReferences(text),
      documentTokens = tokens.filter(
        (token) =>
          token.startsWith("git:") || !isImagePath(token.split("::", 1)[0]!),
      );
    if (total > this.config.limits.maxInputBytes)
      throw new AgentError(
        "INPUT_SIZE",
        "依頼と添付ファイルが入力上限を超えています。",
      );
    if (documentTokens.length > maxPreparedDocuments)
      throw new AgentError(
        "INPUT_SIZE",
        `At most ${maxPreparedDocuments} documents may be attached`,
      );
    if (
      this.session.context?.redactedImageIds?.length &&
      documentTokens.some((token) => token.startsWith("git:"))
    )
      throw new AgentError(
        "GIT_REDACTED",
        "Git attachments are disabled after image redaction; use a separate sanitized conversation",
      );
    const checkedFiles = new Map<number, { path: string; size: number }>(),
      gitSelections = new Map<number, GitInputSelection>();
    for (const [index, token] of tokens.entries()) {
      if (token.startsWith("git:")) {
        if (!this.session.workspace)
          throw new AgentError(
            "WORKSPACE",
            "Git inputs require a configured workspace",
          );
        const selection = await selectGitInput(
          this.session.workspace,
          token,
          Math.min(
            this.config.limits.maxInputBytes - total,
            this.config.limits.maxFileBytes,
          ),
          AbortSignal.timeout(30000),
        );
        if (excludedHashes.has(sha256(selection.raw)))
          throw new AgentError(
            "SOURCE_EXCLUDED",
            "Git attachment belongs to an excluded source family",
          );
        rawDocumentBytes += selection.raw.length;
        if (rawDocumentBytes > maxPreparedInputBytes)
          throw new AgentError(
            "INPUT_SIZE",
            "Cumulative document attachments exceed the raw input budget",
          );
        gitSelections.set(index, selection);
      } else {
        const actualPath = token.split("::", 1)[0]!;
        if (secretPath(actualPath))
          throw new AgentError(
            "PATH_DENIED",
            "認証・制御ファイルは添付できません。",
          );
        if (isImagePath(actualPath)) continue;
        const safe = await safePath(this.session.workspace, actualPath),
          info = await lstat(safe);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          throw new AgentError(
            "PATH_DENIED",
            "Attachment must be a regular non-linked file",
          );
        rawDocumentBytes += info.size;
        if (rawDocumentBytes > maxPreparedInputBytes)
          throw new AgentError(
            "INPUT_SIZE",
            "Cumulative document attachments exceed the raw input budget",
          );
        checkedFiles.set(index, { path: safe, size: info.size });
      }
    }
    for (const [index, token] of tokens.entries()) {
      if (token.startsWith("git:")) {
        const prepared = await storeGitInput(
          this.paths,
          gitSelections.get(index)!,
        );
        documents.push(prepared.reference);
        total += prepared.reference.selectedBytes;
        attachments.push({
          path: `@${token}`,
          bytes: prepared.reference.selectedBytes,
          id: prepared.reference.id,
          locator: prepared.reference.locator,
        });
        continue;
      }
      const actualPath = token.split("::", 1)[0]!;
      const checkedFile = checkedFiles.get(index),
        safe =
          checkedFile?.path ??
          (await safePath(this.session.workspace, actualPath));
      if (!isImagePath(actualPath)) {
        if (await isImageFileSignature(safe))
          throw new AgentError(
            "IMAGE_FORMAT",
            "Image file extension does not match PNG, JPEG, or WebP content",
          );
      }
      if (isImagePath(actualPath)) {
        if (token !== actualPath)
          throw new AgentError(
            "INPUT_SELECTOR",
            "Image attachments do not accept document selectors",
          );
        const bytes = await readBoundedImage(safe);
        const mimeType = imageMimeForPath(actualPath)!;
        const metadata = await validateImage(bytes, mimeType);
        const imageId = `img-${sha256(bytes)}`;
        this.assertImageNotExcluded(imageId, sha256(bytes));
        if (this.session.context?.redactedImageIds?.includes(imageId))
          throw new AgentError(
            "IMAGE_REDACTED",
            "This image was redacted in the conversation; stage it in a new conversation instead",
          );
        const known = new Map(
          mergeImageReferences(this.session.images ?? [], fresh).map((ref) => [
            ref.id,
            ref,
          ]),
        );
        if (!known.has(imageId)) {
          if (known.size >= maxConversationImages)
            throw new AgentError(
              "IMAGE_LIMIT",
              `A conversation can retain at most ${maxConversationImages} images`,
            );
          const retainedBytes = [...known.values()].reduce(
            (sum, ref) => sum + ref.bytes,
            0,
          );
          if (retainedBytes + bytes.length > maxConversationImageBytes)
            throw new AgentError(
              "IMAGE_LIMIT",
              `A conversation can retain at most ${maxConversationImageBytes} image bytes`,
            );
        }
        const disclosure = this.effectiveDisclosure([
          ...(this.session.images ?? []),
          ...fresh,
        ]);
        const reference = await saveImage(
          this.paths,
          basename(actualPath),
          bytes,
          disclosure.dataClass,
          disclosure.localOnly,
        );
        if (
          reference.width !== metadata.width ||
          reference.height !== metadata.height
        )
          throw new AgentError("IMAGE_INVALID", "Image metadata changed");
        fresh.push(reference);
        attachments.push({ path: token, bytes: bytes.length, mimeType });
      } else {
        const parsed = parseDocumentToken(token);
        if (parsed.path !== actualPath)
          throw new AgentError(
            "PATH_DENIED",
            "Attachment selectors cannot alter the checked path",
          );
        const remaining = Math.max(
          0,
          maxConversationImages -
            new Set(
              [...(this.session.images ?? []), ...fresh].map((ref) => ref.id),
            ).size,
        );
        const prepared = await prepareDocument(
          this.paths,
          safe,
          token,
          Math.min(
            this.config.limits.maxInputBytes - total,
            this.config.limits.maxFileBytes,
          ),
          {
            sandbox: new Sandbox(this.config.execution),
            dataClass: this.session.dataClass,
            localOnly: this.session.localOnly,
            expectedBytes: checkedFile?.size,
            remainingImages: remaining,
            signal: AbortSignal.timeout(30000),
          },
        );
        if (
          excludedIds.has(prepared.reference.id) ||
          excludedHashes.has(prepared.reference.rawSha256) ||
          excludedHashes.has(prepared.reference.selectedSha256)
        )
          throw new AgentError(
            "SOURCE_EXCLUDED",
            "Attachment belongs to an excluded source family",
          );
        documents.push(prepared.reference);
        fresh.push(...(prepared.images ?? []));
        total += prepared.reference.selectedBytes;
        attachments.push({
          path: token,
          bytes: prepared.reference.selectedBytes,
          id: prepared.reference.id,
          locator: prepared.reference.locator,
          partial: prepared.reference.partial,
        });
      }
    }
    if (total > this.config.limits.maxInputBytes)
      throw new AgentError(
        "INPUT_SIZE",
        "依頼と添付ファイルが入力上限を超えています。",
      );
    const excludedImage = (image: ImageReference): boolean =>
      (this.session.context?.excludedSourceIds ?? []).includes(image.id) ||
      (this.session.context?.excludedSourceHashes ?? []).includes(image.sha256);
    const images = mergeImageReferences(
      this.session.images ?? [],
      fresh,
    ).filter((image) => !excludedImage(image));
    if (
      images.length > maxConversationImages ||
      images.reduce((sum, ref) => sum + ref.bytes, 0) >
        maxConversationImageBytes
    )
      throw new AgentError(
        "IMAGE_LIMIT",
        `A conversation can retain at most ${maxConversationImages} images and ${maxConversationImageBytes} image bytes`,
      );
    for (const ref of images) await loadStoredImage(this.paths, ref);
    const disclosure = this.effectiveDisclosure(images);
    const previous = this.session.latestRunId
      ? this.store.get(this.session.latestRunId)
      : undefined;
    const kind =
      this.session.kind === "auto"
        ? inferKind(text, previous?.kind)
        : this.session.kind;
    const accessOverride = this.accessOverride,
      access = effectiveAccess(
        text,
        previous?.access ?? this.session.access ?? "read-only",
        accessOverride,
      );
    const binding = sha256(
      canonical({
        conversation: this.session.id,
        config: configHash(this.config),
        text,
        dataClass: disclosure.dataClass,
        localOnly: disclosure.localOnly,
        kind,
        strategy: this.session.strategy,
        model: this.session.model,
        reviewer: this.session.reviewer,
        access,
        accessOverride,
        documents,
        imageIds: images.map((ref) => ref.id),
      }),
    );
    return {
      text,
      attachments,
      images,
      documents,
      destinationBinding: binding,
      configHash: configHash(this.config),
      dataClass: disclosure.dataClass,
      localOnly: disclosure.localOnly,
      kind,
      strategy: this.session.strategy,
      model: this.session.model,
      reviewer: this.session.reviewer,
      access,
      accessOverride,
    };
  }
  async previewInput(text: string): Promise<InputPreview> {
    const snapshot = await this.snapshotInput(text);
    const destinations = this.inputDestinations(snapshot.images, snapshot);
    const preview: InputPreview = {
      text,
      attachments: structuredClone(snapshot.attachments),
      images: structuredClone(snapshot.images),
      documents: structuredClone(snapshot.documents),
      destinations,
      dataClass: snapshot.dataClass,
      localOnly: snapshot.localOnly,
      access: snapshot.access,
      accessOverride: snapshot.accessOverride,
    };
    this.previews.set(preview, snapshot);
    return preview;
  }
  setAccessOverride(access: RequestAccess): void {
    this.accessOverride = access;
    this.publish("notice", {
      text: `次の送信1回のみ access を ${access} に上書きします。現在の依頼に明示的な禁止表現があれば read-only が優先されます。`,
    });
  }
  private inputDestinations(
    images: ImageReference[],
    snapshot: Pick<
      InputSnapshot,
      | "dataClass"
      | "localOnly"
      | "kind"
      | "attachments"
      | "strategy"
      | "model"
      | "reviewer"
      | "access"
    >,
  ): string[] {
    if (!images.length && !snapshot.attachments.length) return [];
    const kind = snapshot.kind;
    const run = {
      kind,
      mode: snapshot.strategy,
      dataClass: snapshot.dataClass,
      localOnly: snapshot.localOnly,
      access: snapshot.access,
      images,
      inputs: snapshot.attachments
        .filter((attachment) => !attachment.mimeType)
        .map((attachment) => attachment.path),
    } as Run;
    const workerNeedsTools =
      kind !== "chat" ||
      snapshot.attachments.some((attachment) => !attachment.mimeType);
    const candidates = {
      lead: modelCandidates(this.config, run, "lead", true),
      worker: modelCandidates(this.config, run, "worker", workerNeedsTools),
      reviewer: modelCandidates(this.config, run, "reviewer", true),
    };
    const requiredRoles =
      kind === "chat"
        ? (["worker"] as const)
        : snapshot.strategy === "assisted"
          ? (["lead", "worker"] as const)
          : snapshot.strategy === "reviewed"
            ? (["worker", "reviewer"] as const)
            : (["worker"] as const);
    const requestedRole =
      kind !== "chat" && snapshot.strategy === "assisted" ? "lead" : "worker";
    const selectedWorker =
      snapshot.model && candidates.worker.includes(snapshot.model)
        ? snapshot.model
        : candidates.worker[0];
    const reviewerCandidates =
      kind !== "chat" && snapshot.strategy === "reviewed"
        ? modelCandidates(this.config, run, "reviewer", true, selectedWorker)
        : candidates.reviewer;
    const rolesForAlternatives = new Set<string>();
    for (const role of requiredRoles) rolesForAlternatives.add(role);
    if (kind !== "chat" && snapshot.strategy === "assisted")
      rolesForAlternatives.add("reviewer");
    const aliases = new Set<string>();
    for (const role of rolesForAlternatives) {
      const eligible =
        role === "reviewer" &&
        kind !== "chat" &&
        snapshot.strategy === "reviewed"
          ? reviewerCandidates
          : candidates[role as keyof typeof candidates];
      for (const alias of eligible) aliases.add(alias);
    }
    const destinations = [...aliases]
      .map((alias) => {
        const connection =
          this.config.connections[this.config.models[alias]!.connection]!;
        let target: string;
        try {
          const url = new URL(endpoint(connection));
          url.username = "";
          url.password = "";
          url.search = "";
          url.hash = "";
          target = url.toString();
        } catch {
          target = "endpoint unavailable";
        }
        return `${alias} — ${connection.type}/${this.config.models[alias]!.connection} — ${target}`;
      })
      .sort();
    const alternatives = destinations.length
      ? ` Authorized ${images.length ? "image-capable" : "attachment-capable"} alternatives: ${destinations.join("; ")}.`
      : ` No authorized ${images.length ? "image-capable" : "attachment-capable"} alternatives are available.`;
    const missingRole = requiredRoles.find(
      (role) =>
        !(role === "reviewer" ? reviewerCandidates : candidates[role]).length,
    );
    if (missingRole)
      throw new AgentError(
        "NO_IMAGE_MODEL",
        `No authorized ${images.length ? "image-capable" : "attachment-capable"} ${missingRole} model is available for ${kind}/${snapshot.dataClass}${snapshot.localOnly ? "/local-only" : ""}.${alternatives}`,
      );
    if (
      kind !== "chat" &&
      snapshot.strategy === "reviewed" &&
      snapshot.reviewer &&
      !reviewerCandidates.includes(snapshot.reviewer)
    )
      throw new AgentError(
        "NO_IMAGE_MODEL",
        `Selected reviewer ${snapshot.reviewer} is not an authorized ${images.length ? "image-capable" : "attachment-capable"} reviewer model.${alternatives}`,
      );
    if (snapshot.model && !candidates[requestedRole].includes(snapshot.model))
      throw new AgentError(
        "NO_IMAGE_MODEL",
        `Selected model ${snapshot.model} is not an authorized ${images.length ? "image-capable" : "attachment-capable"} ${requestedRole} model.${alternatives}`,
      );
    return destinations;
  }
  private approvedSnapshot(
    text: string,
    preview?: InputPreview,
  ): InputSnapshot {
    if (!preview) throw new AgentError("INPUT", "Missing input preview");
    const snapshot = this.previews.get(preview);
    if (
      !snapshot ||
      snapshot.text !== text ||
      preview.text !== text ||
      canonical(preview.attachments) !== canonical(snapshot.attachments) ||
      canonical(preview.images) !== canonical(snapshot.images) ||
      canonical(preview.documents) !== canonical(snapshot.documents) ||
      preview.dataClass !== snapshot.dataClass ||
      preview.localOnly !== snapshot.localOnly ||
      preview.access !== snapshot.access ||
      preview.accessOverride !== snapshot.accessOverride
    )
      throw new AgentError(
        "IMAGE_PREVIEW",
        "Input preview is invalid; review the input again",
      );
    if (
      (snapshot.images.length || snapshot.documents.length) &&
      snapshot.configHash !== configHash(this.config)
    )
      throw new AgentError(
        "IMAGE_PREVIEW_STALE",
        "Configuration changed after preview; review the input and destinations again",
      );
    if (
      canonical(preview.destinations) !==
      canonical(this.inputDestinations(snapshot.images, snapshot))
    )
      throw new AgentError(
        "IMAGE_PREVIEW",
        "Input preview destinations changed; review the input again",
      );
    const current = this.effectiveDisclosure(snapshot.images);
    const previous = this.session.latestRunId
      ? this.store.get(this.session.latestRunId)
      : undefined;
    const kind =
      this.session.kind === "auto"
        ? inferKind(text, previous?.kind)
        : this.session.kind;
    const currentBinding = sha256(
      canonical({
        conversation: this.session.id,
        config: configHash(this.config),
        text,
        dataClass: current.dataClass,
        localOnly: current.localOnly,
        kind,
        strategy: this.session.strategy,
        model: this.session.model,
        reviewer: this.session.reviewer,
        access: snapshot.access,
        accessOverride: snapshot.accessOverride,
        documents: snapshot.documents,
        imageIds: snapshot.images.map((ref) => ref.id),
      }),
    );
    const effective = effectiveAccess(
      text,
      previous?.access ?? this.session.access ?? "read-only",
      this.accessOverride,
    );
    if (
      this.accessOverride !== snapshot.accessOverride ||
      effective !== snapshot.access ||
      ((snapshot.images.length || snapshot.documents.length) &&
        (currentBinding !== snapshot.destinationBinding ||
          kind !== snapshot.kind ||
          this.session.strategy !== snapshot.strategy ||
          this.session.model !== snapshot.model ||
          this.session.reviewer !== snapshot.reviewer))
    )
      throw new AgentError(
        "IMAGE_PREVIEW_STALE",
        "Conversation privacy settings changed after preview; review the input again",
      );
    return structuredClone(snapshot);
  }
  async attachments(text: string): Promise<{ path: string; bytes: number }[]> {
    const snapshot = await this.snapshotInput(text);
    return snapshot.attachments.map(({ path, bytes }) => ({ path, bytes }));
  }
  async submit(
    text: string,
    mode: PendingInput["mode"] = "instruction",
    preview?: InputPreview,
  ): Promise<void> {
    if (!text.trim()) return;
    const snapshot = preview
      ? this.approvedSnapshot(text, preview)
      : this.approvedSnapshot(text, await this.previewInput(text));
    if (this.busy && mode === "instruction" && fileReferences(text).length)
      throw new AgentError(
        "INPUT",
        "実行中に新しいファイルを添付する場合は Alt+Enter または /next で次の依頼にしてください。現在のコピー内のパスは @ を付けずに参照できます。",
      );
    if (this.session.queue.length >= 30)
      throw new AgentError("QUEUE", "待機入力は30件までです。");
    const item: PendingInput = {
      id: id(),
      text,
      mode: this.busy ? mode : "next",
      runId: this.busy && mode === "instruction" ? this.activeRunId : undefined,
      images: structuredClone(snapshot.images),
      documents: structuredClone(snapshot.documents),
      previewBinding: snapshot.destinationBinding,
      previewConfigHash: snapshot.configHash,
      previewDataClass: snapshot.dataClass,
      previewLocalOnly: snapshot.localOnly,
      previewKind: snapshot.kind,
      previewModel: snapshot.model,
      previewStrategy: snapshot.strategy,
      previewReviewer: snapshot.reviewer,
      previewAccess: snapshot.access,
      previewAccessOverride: snapshot.accessOverride,
    };
    if (!this.session.latestRunId && this.session.name === "新しい会話")
      this.session.name = text.split("\n")[0]!;
    this.session.queue.push(item);
    if (snapshot.accessOverride !== undefined) this.accessOverride = undefined;
    this.session.images = structuredClone(snapshot.images);
    this.session.draft = "";
    this.save();
    if (snapshot.accessOverride)
      this.publish("notice", {
        text: `access override ${snapshot.accessOverride} を今回の送信に適用し、1回分を消費しました。`,
      });
    if (this.busy)
      this.publish("notice", {
        text:
          mode === "instruction"
            ? "追加指示を受付。次の Task 境界で要件と検証を更新します。"
            : "完了後の依頼として保存しました。",
      });
    else this.startQueue();
  }
  editQueued(inputId: string, text: string, preview?: InputPreview): void {
    if (Buffer.byteLength(text) > this.config.limits.maxInputBytes)
      throw new AgentError("INPUT_SIZE", "入力上限を超えています。");
    const item = this.session.queue.find((q) => q.id === inputId);
    if (!item)
      throw new AgentError("QUEUE", "この入力は既に処理されています。");
    if (
      (item.images?.length || fileReferences(text).some(isImagePath)) &&
      !preview
    )
      throw new AgentError(
        "IMAGE_PREVIEW",
        "Edit image inputs through a new preview and confirmation",
      );
    const snapshot = preview ? this.approvedSnapshot(text, preview) : undefined;
    item.text = text;
    item.images = snapshot?.images;
    item.documents = snapshot?.documents;
    item.previewBinding = snapshot?.destinationBinding;
    item.previewConfigHash = snapshot?.configHash;
    item.previewDataClass = snapshot?.dataClass;
    item.previewLocalOnly = snapshot?.localOnly;
    item.previewKind = snapshot?.kind;
    item.previewModel = snapshot?.model;
    item.previewStrategy = snapshot?.strategy;
    item.previewReviewer = snapshot?.reviewer;
    item.previewAccess = snapshot?.access;
    item.previewAccessOverride = snapshot?.accessOverride;
    if (snapshot) this.session.images = structuredClone(snapshot.images);
    this.save();
  }
  cancelQueued(inputId: string): void {
    this.session.queue = this.session.queue.filter((q) => q.id !== inputId);
    this.save();
  }
  startQueue(): void {
    if (this.busy || this.closed) return;
    const next = this.session.queue.find((q) => q.mode === "next");
    if (!next) return;
    this.busy = true;
    this.controller = new AbortController();
    const generation = this.generation;
    let succeeded = false;
    this.work = this.execute(next, generation)
      .then(() => {
        succeeded = this.currentRun()?.state === "succeeded";
      })
      .catch((error) => {
        this.publish("notice", { text: errorMessage(error) });
      })
      .finally(() => {
        this.busy = false;
        this.activeRunId = undefined;
        this.publish("changed");
      });
    void this.work.then(() => {
      const latest =
        this.session.latestRunId && this.store.get(this.session.latestRunId);
      if (
        succeeded &&
        !this.controller?.signal.aborted &&
        latest &&
        latest.state === "succeeded" &&
        !this.session.queue.some((q) => q.mode === "instruction")
      )
        this.startQueue();
    });
  }
  async waitForIdle(): Promise<void> {
    while (this.busy) await this.work;
  }
  stop(): void {
    this.controller?.abort();
    this.publish("notice", {
      text: "中断を要求しました。未確定操作と待機入力は保存します。",
    });
  }
  private async execute(
    input: PendingInput,
    generation: number,
  ): Promise<void> {
    const signal = this.controller!.signal;
    const previous = this.session.latestRunId
      ? this.store.get(this.session.latestRunId)
      : undefined;
    const kind =
      this.session.kind === "auto"
        ? inferKind(input.text, previous?.kind)
        : this.session.kind;
    const access = effectiveAccess(
      input.text,
      previous?.access ?? this.session.access ?? "read-only",
      input.previewAccessOverride,
    );
    if (input.previewAccess && input.previewAccess !== access)
      throw new AgentError(
        "ACCESS_PREVIEW_STALE",
        "Queued access changed after confirmation; review the request again",
      );
    if (
      this.session.context?.redactedImageIds?.length &&
      input.documents?.some((reference) => reference.format === "git")
    )
      throw new AgentError(
        "GIT_REDACTED",
        "Git attachments are unavailable after image redaction; use a separate sanitized conversation",
      );
    const queuedDocuments = input.documents ?? [];
    const excludedIds = new Set(this.session.context?.excludedSourceIds ?? []);
    const excludedHashes = new Set(
      this.session.context?.excludedSourceHashes ?? [],
    );
    if (queuedDocuments.length > maxPreparedDocuments)
      throw new AgentError(
        "INPUT_SIZE",
        `At most ${maxPreparedDocuments} documents may be attached to one request`,
      );
    let rawInputBytes = 0;
    let selectedInputBytes = Buffer.byteLength(input.text);
    if (selectedInputBytes > this.config.limits.maxInputBytes)
      throw new AgentError("INPUT_SIZE", "Request exceeds the input limit");
    for (const reference of queuedDocuments) {
      if (
        excludedIds.has(reference.id) ||
        excludedHashes.has(reference.rawSha256) ||
        excludedHashes.has(reference.selectedSha256)
      )
        throw new AgentError(
          "SOURCE_EXCLUDED",
          "Queued attachment belongs to an excluded source family",
        );
      if (
        !Number.isSafeInteger(reference.rawBytes) ||
        reference.rawBytes < 0 ||
        reference.rawBytes > maxDocumentBytes ||
        !Number.isSafeInteger(reference.selectedBytes) ||
        reference.selectedBytes < 0 ||
        reference.selectedBytes > maxDocumentBytes
      )
        throw new AgentError(
          "INPUT_INTEGRITY",
          "Queued attachment has an invalid raw-byte size",
        );
      rawInputBytes += reference.rawBytes;
      if (rawInputBytes > maxPreparedInputBytes)
        throw new AgentError(
          "INPUT_SIZE",
          "Cumulative document attachments exceed the raw input budget",
        );
      selectedInputBytes += reference.selectedBytes;
      if (selectedInputBytes > this.config.limits.maxInputBytes)
        throw new AgentError(
          "INPUT_SIZE",
          "Cumulative selected attachments exceed the request input budget",
        );
    }
    const preparedInputs: PreparedInput[] = [];
    for (const reference of queuedDocuments)
      preparedInputs.push(await loadPreparedInput(this.paths, reference));
    if (
      fileReferences(input.text).some((token) => {
        const path = token.split("::", 1)[0]!;
        return !isImagePath(path) && !token.startsWith("@git:");
      }) &&
      !input.documents?.length
    )
      throw new AgentError(
        "INPUT_PREVIEW_STALE",
        "Queued attachment has no immutable selection; review it again",
      );
    const mergedImages = mergeImageReferences(
      this.session.images ?? [],
      input.images ?? this.session.images ?? [],
    );
    const excludedImage = (image: ImageReference): boolean =>
      excludedIds.has(image.id) || excludedHashes.has(image.sha256);
    if (input.images?.some(excludedImage))
      throw new AgentError(
        "SOURCE_EXCLUDED",
        "Image belongs to an excluded source family",
      );
    const images = mergedImages.filter((image) => !excludedImage(image));
    const preparedForRun = preparedInputs.map((prepared) => {
      const imageIds = prepared.reference.imageIds ?? [],
        attachedImages = imageIds.map((imageId) =>
          images.find((image) => image.id === imageId),
        );
      if (attachedImages.some((image) => !image))
        throw new AgentError(
          "INPUT_PREVIEW_STALE",
          "A queued PDF page image was removed; review the attachment again",
        );
      return { ...prepared, images: attachedImages as ImageReference[] };
    });
    if (images.length || preparedInputs.length) {
      const disclosure = this.effectiveDisclosure(images);
      const binding = sha256(
        canonical({
          conversation: this.session.id,
          config: configHash(this.config),
          text: input.text,
          dataClass: input.previewDataClass,
          localOnly: input.previewLocalOnly,
          kind,
          strategy: input.previewStrategy,
          model: input.previewModel,
          reviewer: input.previewReviewer,
          access,
          accessOverride: input.previewAccessOverride,
          documents: input.documents ?? [],
          imageIds: images.map((ref) => ref.id),
        }),
      );
      if (
        !input.previewBinding ||
        input.previewConfigHash !== configHash(this.config) ||
        input.previewBinding !== binding ||
        input.previewKind !== kind ||
        input.previewStrategy !== this.session.strategy ||
        input.previewModel !== this.session.model ||
        input.previewReviewer !== this.session.reviewer ||
        input.previewAccess !== access ||
        disclosure.dataClass !== input.previewDataClass ||
        disclosure.localOnly !== input.previewLocalOnly
      )
        throw new AgentError(
          "IMAGE_PREVIEW_STALE",
          "Queued image input needs a new preview and confirmation after configuration or privacy changes",
        );
      this.inputDestinations(images, {
        dataClass: disclosure.dataClass,
        localOnly: disclosure.localOnly,
        kind,
        access,
        attachments: fileReferences(input.text)
          .filter((path) => !isImagePath(path))
          .map((path) => ({ path, bytes: 0 })),
        strategy: input.previewStrategy!,
        model: input.previewModel,
        reviewer: input.previewReviewer,
      });
    }
    const config = structuredClone(this.config);
    const requestDisclosure = this.effectiveDisclosure(images);
    if (
      previous &&
      (["public", "private", "restricted"].indexOf(
        requestDisclosure.dataClass,
      ) < ["public", "private", "restricted"].indexOf(previous.dataClass) ||
        (previous.localOnly && !requestDisclosure.localOnly))
    )
      throw new AgentError(
        "DISCLOSURE_DENIED",
        "既存会話の送信範囲を広げるには新しい会話を使ってください。",
      );
    const runtime = await this.runtimeFactory(config);
    signal.throwIfAborted();
    const harness = new Harness(
      config,
      this.paths,
      this.store,
      runtime,
      (type, detail) => {
        if (
          generation === this.generation &&
          (!detail.runId || detail.runId === this.activeRunId)
        )
          this.publish(
            type,
            detail,
            typeof detail.runId === "string" ? detail.runId : this.activeRunId,
          );
      },
    );
    const contextRunId = this.session.contextRunId ?? this.session.latestRunId;
    const contextRun = contextRunId ? this.store.get(contextRunId) : undefined;
    const previousSessions: NonNullable<Run["previousSessions"]> = {};
    if (
      !this.session.compacted &&
      contextRun?.kind === kind &&
      contextRun.access === access &&
      contextRun.mode === this.session.strategy &&
      contextRun.dataClass === requestDisclosure.dataClass &&
      contextRun.localOnly === requestDisclosure.localOnly &&
      canonical({
        ids: contextRun.contextState?.excludedSourceIds ?? [],
        hashes: contextRun.contextState?.excludedSourceHashes ?? [],
        urls: contextRun.contextState?.excludedSourceUrls ?? [],
      }) ===
        canonical({
          ids: this.session.context?.excludedSourceIds ?? [],
          hashes: this.session.context?.excludedSourceHashes ?? [],
          urls: this.session.context?.excludedSourceUrls ?? [],
        })
    )
      for (const task of contextRun.tasks)
        if (task.sessionFile && task.model)
          previousSessions[task.id] = {
            model: task.model,
            file: task.sessionFile,
          };
    const parentRunId =
      access !== "change"
        ? undefined
        : kind === "coding"
          ? this.session.workRunId
          : kind === "writing" || kind === "research"
            ? this.session.documentRunId
            : undefined;
    const usableParent =
      parentRunId &&
      (this.store.get(parentRunId).kind === kind ||
        ["writing", "research"].includes(kind))
        ? parentRunId
        : undefined;
    const contextState = normalizeConversationContext(this.session.context);
    contextState.sourceIds = contextState.sourceIds.filter(
      (sourceId) => !excludedIds.has(sourceId),
    );
    contextState.imageIds = contextState.imageIds.filter(
      (imageId) => !excludedIds.has(imageId),
    );
    if (contextState.redactedImageIds?.length) {
      const unavailableGitArtifacts = this.conversations
        .runs(this.session.id)
        .flatMap((runId) => this.store.artifacts(runId))
        .filter(
          (artifact) =>
            artifact.kind === "source" && artifact.metadata.format === "git",
        );
      const unavailableGitSources = new Set(
          unavailableGitArtifacts.map((artifact) => artifact.id),
        ),
        unavailableGitNames = new Set(
          unavailableGitArtifacts.map((artifact) => artifact.name),
        );
      contextState.sourceIds = contextState.sourceIds.filter(
        (sourceId) => !unavailableGitSources.has(sourceId),
      );
      contextState.workingState.artifacts =
        contextState.workingState.artifacts.filter(
          (artifactId) => !unavailableGitSources.has(artifactId),
        );
      contextState.workingState.hashes = Object.fromEntries(
        Object.entries(contextState.workingState.hashes).filter(
          ([name]) => !unavailableGitNames.has(name),
        ),
      );
      contextState.workingState.history = contextState.workingState.history.map(
        (entry) => ({
          ...entry,
          artifacts: entry.artifacts.filter(
            (artifactId) => !unavailableGitSources.has(artifactId),
          ),
          hashes: Object.fromEntries(
            Object.entries(entry.hashes).filter(
              ([name]) => !unavailableGitNames.has(name),
            ),
          ),
        }),
      );
    }
    const instructions = this.conversations
      .messages(this.session.id)
      .map((message) => ({
        seq: message.seq,
        role: message.role,
        text: message.text,
        ...(message.run_id ? { runId: message.run_id } : {}),
      }));
    instructions.push({
      seq: Number.MAX_SAFE_INTEGER,
      role: "user",
      text: input.text,
    });
    contextState.instructions = instructions;
    contextState.imageIds = images.map((image) => image.id);
    contextState.originalRunIds = [
      ...new Set([
        ...contextState.originalRunIds,
        ...(this.session.contextRunId ? [this.session.contextRunId] : []),
      ]),
    ];
    // A context handoff carries verified status and references; Pi alone owns model turns.
    let legacyHandoff: unknown;
    if (!this.session.handoff && contextRun) {
      const path = join(this.store.runDir(contextRun.id), "handoff.json");
      try {
        const info = await lstat(path);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          (info.mode & 0o077) !== 0 ||
          (process.getuid && info.uid !== process.getuid()) ||
          info.size > this.config.limits.maxInputBytes
        )
          throw new AgentError(
            "UNSAFE_STORAGE",
            "Legacy handoff must be a bounded private regular file",
          );
        legacyHandoff = JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const context = canonical({
      version: 2,
      conversationContext: contextState,
      handoff:
        this.session.handoff ??
        legacyHandoff ??
        (contextRun
          ? {
              objective: contextRun.objective,
              state: contextRun.state,
              reason: contextRun.reason,
              tasks: contextRun.tasks.map((t) => ({
                role: t.role,
                model: t.model,
                result: t.result,
              })),
              artifacts: this.store
                .artifacts(contextRun.id)
                .map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
            }
          : undefined),
    });
    const inspectRepository =
      access === "read-only" && repositoryIntent(input.text);
    const run = await harness.create({
      extraPaths:
        kind === "coding" && this.session.appliedRunId
          ? Object.keys(
              JSON.parse(
                await readFile(
                  join(
                    this.store.runDir(this.session.appliedRunId),
                    "validated-manifest.json",
                  ),
                  "utf8",
                ),
              ),
            )
          : undefined,
      objective: input.text,
      kind,
      mode: kind === "chat" ? "single" : this.session.strategy,
      dataClass: requestDisclosure.dataClass,
      localOnly: requestDisclosure.localOnly,
      images,
      workspace:
        kind === "coding" || inspectRepository
          ? this.session.workspace
          : undefined,
      parentRunId: usableParent,
      snapshotRunId: inspectRepository ? this.session.workRunId : undefined,
      sourceRunIds: this.conversations
        .runs(this.session.id)
        .filter((sourceRunId) =>
          this.store
            .artifacts(sourceRunId)
            .some(
              (artifact) =>
                artifact.kind === "source" &&
                artifact.runId === sourceRunId &&
                contextState.sourceIds.includes(artifact.id),
            ),
        ),
      previousSessions,
      context,
      contextState,
      redactedImageHashes: (contextState.redactedImageIds ?? []).map(
        (imageId) => imageId.replace(/^img-/, ""),
      ),
      conversationId: this.session.id,
      constraints: contextState.constraints,
      access,
      compactions: contextState.compactions,
      includeUntracked: this.session.includeUntracked,
      model: this.session.model,
      reviewer: this.session.reviewer,
      preparedInputs: preparedForRun,
      checks: kind === "coding" ? this.session.checks : [],
    });
    this.activeRunId = run.id;
    this.store.transaction(() => {
      this.conversations.link(this.session, run);
      this.session.latestRunId = run.id;
      this.session.context = contextState;
      if (access === "change" && kind === "coding")
        this.session.workRunId = run.id;
      if (access === "change" && (kind === "writing" || kind === "research"))
        this.session.documentRunId = run.id;
      this.session.queue = this.session.queue.filter((q) => q.id !== input.id);
      this.conversations.message(this.session, "user", input.text, run.id);
      this.conversations.save(this.session);
    });
    this.publish("run_started", { kind, mode: run.mode });
    await this.executePrepared(harness, run, signal);
  }
  imagePath(ref: ImageReference): string {
    validateImageReference(ref);
    if (!this.session.images?.some((image) => image.id === ref.id))
      throw new AgentError(
        "IMAGE_REFERENCE",
        "Image is not retained by this conversation",
      );
    return join(this.paths.home, "images", `${ref.sha256}.img`);
  }
  private assertImageNotExcluded(imageId: string, hash: string): void {
    if (
      this.session.context?.excludedSourceIds?.includes(imageId) ||
      this.session.context?.excludedSourceHashes?.includes(hash)
    )
      throw new AgentError(
        "SOURCE_EXCLUDED",
        "This image belongs to an excluded source family; use a separate conversation to attach it again",
      );
  }
  async stageClipboardImage(): Promise<ImageReference> {
    if (this.busy)
      throw new AgentError(
        "IMAGE_BUSY",
        "Wait for the current request before staging an image",
      );
    const bytes = await readClipboardPng();
    const imageId = `img-${sha256(bytes)}`;
    this.assertImageNotExcluded(imageId, sha256(bytes));
    if (this.session.context?.redactedImageIds?.includes(imageId))
      throw new AgentError(
        "IMAGE_REDACTED",
        "This image was redacted in the conversation; stage it in a new conversation instead",
      );
    if (
      !(this.session.images ?? []).some((image) => image.id === imageId) &&
      ((this.session.images?.length ?? 0) >= maxConversationImages ||
        (this.session.images ?? []).reduce(
          (sum, image) => sum + image.bytes,
          0,
        ) +
          bytes.length >
          maxConversationImageBytes)
    )
      throw new AgentError(
        "IMAGE_LIMIT",
        "Conversation image capacity is exhausted",
      );
    const ref = mergeImageReferences(this.session.images ?? [], [
      await saveImage(
        this.paths,
        "clipboard.png",
        bytes,
        this.session.dataClass,
        this.session.localOnly,
      ),
    ]).find((image) => image.id === imageId)!;
    this.session.images = mergeImageReferences(this.session.images ?? [], [
      ref,
    ]);
    this.save();
    return ref;
  }
  async stageImageFromPath(path: string): Promise<ImageReference> {
    if (this.busy)
      throw new AgentError(
        "IMAGE_BUSY",
        "Wait for the current request before staging an image",
      );
    if (!this.session.workspace)
      throw new AgentError("WORKSPACE", "Image staging requires a workspace");
    if (!isImagePath(path) || secretPath(path))
      throw new AgentError(
        "PATH_DENIED",
        "Stage a PNG, JPEG, or WebP inside the workspace",
      );
    const safe = await safePath(this.session.workspace, path);
    const inputStat = await lstat(safe);
    if (
      inputStat.isSymbolicLink() ||
      !inputStat.isFile() ||
      inputStat.nlink !== 1
    )
      throw new AgentError(
        "PATH_DENIED",
        "Image path must be a regular non-linked file",
      );
    const bytes = await readBoundedImage(safe),
      mimeType = imageMimeForPath(path)!;
    await validateImage(bytes, mimeType);
    const imageId = `img-${sha256(bytes)}`;
    this.assertImageNotExcluded(imageId, sha256(bytes));
    if (this.session.context?.redactedImageIds?.includes(imageId))
      throw new AgentError(
        "IMAGE_REDACTED",
        "This image was redacted in the conversation; stage it in a new conversation instead",
      );
    const alreadyRetained = (this.session.images ?? []).some(
      (image) => image.id === imageId,
    );
    if (
      !alreadyRetained &&
      ((this.session.images?.length ?? 0) >= maxConversationImages ||
        (this.session.images ?? []).reduce(
          (sum, image) => sum + image.bytes,
          0,
        ) +
          bytes.length >
          maxConversationImageBytes)
    )
      throw new AgentError(
        "IMAGE_LIMIT",
        "Conversation image capacity is exhausted",
      );
    const ref = mergeImageReferences(this.session.images ?? [], [
      await saveImage(
        this.paths,
        basename(safe),
        bytes,
        this.session.dataClass,
        this.session.localOnly,
      ),
    ]).find((image) => image.id === imageId)!;
    this.session.images = mergeImageReferences(this.session.images ?? [], [
      ref,
    ]);
    this.save();
    return ref;
  }
  async editImage(
    imageId: string,
    operation: "crop" | "mask",
    bounds: { x: number; y: number; width: number; height: number },
  ): Promise<ImageReference> {
    if (this.busy)
      throw new AgentError("IMAGE_BUSY", "Image edits are idle-only");
    const source = this.session.images?.find((image) => image.id === imageId);
    if (!source)
      throw new AgentError(
        "IMAGE_REFERENCE",
        "Image is not retained by this conversation",
      );
    if (source.documentId)
      throw new AgentError(
        "IMAGE_REDACTED",
        "PDF-linked images cannot be masked or cropped because extracted text would remain; use a sanitized PDF or standalone page image",
      );
    const derived = await transformImage(this.paths, source, operation, bounds);
    if (this.session.context?.redactedImageIds?.includes(derived.id))
      throw new AgentError(
        "IMAGE_REDACTED",
        "This derived image was previously redacted in the conversation",
      );
    if (derived.id === source.id)
      throw new AgentError(
        "IMAGE_REDACTED",
        "The edit did not change image content; no redaction was recorded",
      );
    const retainedImages = [
      ...(this.session.images ?? []).filter((image) => image.id !== source.id),
      derived,
    ];
    if (
      retainedImages.length > maxConversationImages ||
      retainedImages.reduce((sum, image) => sum + image.bytes, 0) >
        maxConversationImageBytes
    )
      throw new AgentError(
        "IMAGE_LIMIT",
        "Edited images exceed the conversation capacity",
      );
    this.removeQueuedImage(source.id);
    this.session.images = retainedImages;
    const context = normalizeConversationContext(this.session.context);
    context.redactedImageIds = [
      ...new Set([...(context.redactedImageIds ?? []), source.id]),
    ];
    context.imageIds = context.imageIds.filter((id) => id !== source.id);
    context.imageIds.push(derived.id);
    this.session.context = context;
    this.session.compacted = true;
    this.save();
    return derived;
  }
  removeImage(imageId: string): void {
    if (this.busy)
      throw new AgentError("IMAGE_BUSY", "Image removal is idle-only");
    const before = this.session.images ?? [];
    if (!before.some((image) => image.id === imageId))
      throw new AgentError(
        "IMAGE_REFERENCE",
        "Image is not retained by this conversation",
      );
    this.removeQueuedImage(imageId);
    this.session.images = before.filter((image) => image.id !== imageId);
    const context = normalizeConversationContext(this.session.context);
    context.redactedImageIds = [
      ...new Set([...(context.redactedImageIds ?? []), imageId]),
    ];
    context.imageIds = context.imageIds.filter((id) => id !== imageId);
    this.session.context = context;
    this.session.compacted = true;
    this.save();
  }
  setImageComparison(firstId: string, secondId: string): void {
    if (this.busy)
      throw new AgentError("IMAGE_BUSY", "Image comparison order is idle-only");
    if (firstId === secondId)
      throw new AgentError("IMAGE_REFERENCE", "Select two different images");
    const images = this.session.images ?? [];
    const first = images.find((image) => image.id === firstId),
      second = images.find((image) => image.id === secondId);
    if (!first || !second)
      throw new AgentError(
        "IMAGE_REFERENCE",
        "Both comparison images must belong to this conversation",
      );
    this.session.images = [
      { ...first, comparisonOrder: 1 },
      { ...second, comparisonOrder: 2 },
      ...images
        .filter((image) => image.id !== firstId && image.id !== secondId)
        .map(({ comparisonOrder: _order, ...image }) => image),
    ];
    this.save();
  }
  private removeQueuedImage(imageId: string): void {
    this.session.queue = this.session.queue.map((item) => ({
      ...item,
      images: item.images?.filter((image) => image.id !== imageId),
    }));
  }
  gitStatus(): Promise<string> {
    return readGitStatus(this.session.workspace);
  }
  private async executePrepared(
    harness: Harness,
    run: Run,
    signal: AbortSignal,
  ): Promise<void> {
    let instructions: PendingInput[] = [];
    const result = await harness.execute(
      run.id,
      signal,
      undefined,
      () => {
        instructions = this.session.queue.filter(
          (q) => q.mode === "instruction" && (!q.runId || q.runId === run.id),
        );
        return instructions.map((q) => q.text);
      },
      () => {
        for (const item of instructions)
          this.conversations.message(this.session, "user", item.text, run.id);
        this.session.queue = this.session.queue.filter(
          (q) => !instructions.some((i) => i.id === q.id),
        );
        this.conversations.save(this.session);
      },
    );
    this.session.contextRunId = result.id;
    const contextState = normalizeConversationContext(
      result.contextState ?? this.session.context,
    );
    contextState.instructions = this.conversations
      .messages(this.session.id)
      .map((message) => ({
        seq: message.seq,
        role: message.role,
        text: message.text,
        ...(message.run_id ? { runId: message.run_id } : {}),
      }));
    contextState.imageIds = [
      ...new Set([
        ...contextState.imageIds,
        ...(result.images ?? []).map((image) => image.id),
      ]),
    ];
    contextState.originalRunIds = [
      ...new Set([
        ...contextState.originalRunIds,
        ...this.conversations.runs(this.session.id),
      ]),
    ];
    contextState.compactions = [
      ...contextState.compactions,
      ...(result.compactions ?? []),
    ].filter(
      (record, index, records) =>
        records.findIndex((candidate) => candidate.id === record.id) === index,
    );
    const artifacts = this.store.artifacts(result.id);
    const currentWork = {
      runId: result.id,
      status: result.state,
      checks: result.checks,
      hashes: Object.fromEntries(
        artifacts.map((artifact) => [artifact.name, artifact.sha256]),
      ),
      artifacts: artifacts.map((artifact) => artifact.id),
      operations: this.store
        .operations(result.id)
        .map(({ id: operationId, task_id, name, status, args_hash }) => ({
          id: operationId,
          taskId: task_id,
          name,
          status,
          argsHash: args_hash,
        })),
      results: result.tasks.map((task) => ({
        role: task.role,
        model: task.model,
        summary: task.result?.summary,
        unresolved: task.result?.unresolved,
        author: "model" as const,
        trusted: false as const,
      })),
    };
    contextState.sourceIds = [
      ...new Set([
        ...contextState.sourceIds,
        ...artifacts
          .filter((artifact) => artifact.kind === "source")
          .map((artifact) => artifact.id),
      ]),
    ];
    contextState.workingState = {
      ...currentWork,
      history: [
        ...contextState.workingState.history.filter(
          (entry) => entry.runId !== result.id,
        ),
        currentWork,
      ],
    };
    this.session.context = contextState;
    this.session.compacted = false;
    this.session.handoffDigest = undefined;
    this.session.handoff = undefined;
    const summary =
      result.state === "succeeded"
        ? result.tasks
            .map((t) => t.result?.summary)
            .filter(Boolean)
            .join("\n\n")
        : `${result.state}: ${result.reason ?? "未完了"}`;
    this.conversations.message(this.session, "assistant", summary, result.id);
    this.save();
    this.publish("run_finished", { run: result });
  }
  async resume(): Promise<void> {
    this.idle();
    const run = this.currentRun();
    if (!run || terminalStates.includes(run.state))
      throw new AgentError(
        "TERMINAL_RUN",
        "完了・失敗・中断した作業は再実行しません。続きの依頼を入力してください。",
      );
    if (run.configHash !== configHash(this.config))
      throw new AgentError(
        "POLICY_CHANGED",
        "設定が変わっています。新しい依頼として続けてください。",
      );
    if (
      canonical({
        ids:
          normalizeConversationContext(this.session.context)
            .excludedSourceIds ?? [],
        hashes:
          normalizeConversationContext(this.session.context)
            .excludedSourceHashes ?? [],
        urls:
          normalizeConversationContext(this.session.context)
            .excludedSourceUrls ?? [],
      }) !==
      canonical({
        ids:
          normalizeConversationContext(run.contextState).excludedSourceIds ??
          [],
        hashes:
          normalizeConversationContext(run.contextState).excludedSourceHashes ??
          [],
        urls:
          normalizeConversationContext(run.contextState).excludedSourceUrls ??
          [],
      })
    )
      throw new AgentError(
        "SOURCE_EXCLUDED",
        "This run predates a source exclusion; continue with a fresh request",
      );
    const activeRedactions = new Set(
      normalizeConversationContext(this.session.context).redactedImageIds ?? [],
    );
    const runRedactions = new Set(
      normalizeConversationContext(run.contextState).redactedImageIds ?? [],
    );
    if (
      activeRedactions.size !== runRedactions.size ||
      [...activeRedactions].some((id) => !runRedactions.has(id)) ||
      [...runRedactions].some((id) => !activeRedactions.has(id)) ||
      run.images?.some((image) => activeRedactions.has(image.id))
    )
      throw new AgentError(
        "IMAGE_REDACTED",
        "This run predates an image redaction; continue with a fresh request",
      );
    this.busy = true;
    this.activeRunId = run.id;
    this.controller = new AbortController();
    const signal = this.controller.signal,
      generation = this.generation;
    this.publish("run_started", { kind: run.kind, mode: run.mode });
    this.work = (async () => {
      const runtime = await this.runtimeFactory(this.config);
      const harness = new Harness(
        this.config,
        this.paths,
        this.store,
        runtime,
        (type, detail) => {
          if (
            generation === this.generation &&
            (!detail.runId || detail.runId === this.activeRunId)
          )
            this.publish(type, detail, run.id);
        },
      );
      await this.executePrepared(harness, run, signal);
    })().finally(() => {
      this.busy = false;
      this.activeRunId = undefined;
      this.publish("changed");
    });
    await this.work;
  }
  async diff(): Promise<{
    runId: string;
    patch: string;
    files: string[];
    applicable: boolean;
    reason?: string;
    token: string;
  }> {
    this.idle();
    const runId = this.session.workRunId;
    const sessionId = this.session.id;
    if (!runId)
      throw new AgentError("DIFF", "未適用のコード変更はありません。");
    const delta = await workspaceDiff(
      this.store.runDir(runId),
      this.config.limits.maxWorkspaceBytes,
    );
    let applicable = false,
      reason: string | undefined;
    try {
      const result = await applyRun(this.config, this.store, runId, true);
      applicable = "applicable" in result && result.applicable === true;
    } catch (error) {
      reason = errorMessage(error);
    }
    this.idle();
    if (this.session.id !== sessionId || this.session.workRunId !== runId)
      throw new AgentError(
        "STALE_VIEW",
        "作業が切り替わりました。差分を開き直してください。",
      );
    return {
      runId,
      patch: delta.patch,
      files: delta.changes.map((c) => c.path),
      applicable,
      reason,
      token: sha256(
        canonical({
          session: this.session.id,
          runId,
          patch: delta.patch,
          config: configHash(this.config),
        }),
      ),
    };
  }
  async apply(token: string): Promise<void> {
    this.idle();
    const current = await this.diff();
    this.idle();
    if (current.runId !== this.session.workRunId)
      throw new AgentError(
        "STALE_VIEW",
        "作業が切り替わりました。差分を開き直してください。",
      );
    if (!current.applicable || current.token !== token)
      throw new AgentError(
        "APPLY",
        "差分または適用条件が変わりました。/diff で確認してください。",
      );
    this.busy = true;
    this.controller = new AbortController();
    this.work = (async () => {
      const result = await applyRun(
        this.config,
        this.store,
        current.runId,
        false,
        this.controller!.signal,
      );
      this.session.appliedRunId = current.runId;
      this.session.workRunId = undefined;
      this.conversations.message(
        this.session,
        "system",
        `適用完了: ${current.files.join(", ")}`,
        current.runId,
      );
      this.save();
      this.publish("applied", { result });
    })().finally(() => {
      this.busy = false;
      this.publish("changed");
    });
    await this.work;
  }
  async reconcile(
    operationId: string,
    outcome: "completed" | "failed",
    note: string,
  ): Promise<void> {
    this.idle();
    if (!note.trim())
      throw new AgentError("OPERATION", "照合した内容を入力してください。");
    const runId = this.session.latestRunId;
    if (!runId) return;
    const run = this.store.claim(runId, true, true);
    try {
      this.store.reconcile(run, operationId, outcome, note);
    } finally {
      this.store.release(run);
    }
    this.publish("changed");
  }
  pins(): ContextNote[] {
    return normalizeConversationContext(this.session.context).pins.filter(
      (note) => note.author === "user" && note.trusted,
    );
  }
  addPin(text: string): void {
    this.idle();
    if (!text.trim()) throw new AgentError("INPUT", "Pin text is required");
    const context = normalizeConversationContext(this.session.context);
    context.pins.push({
      id: id(),
      text,
      kind: "pin",
      author: "user",
      trusted: true,
      updatedAt: Date.now(),
    });
    this.session.context = context;
    this.save();
  }
  addContextNote(kind: "decision" | "question", text: string): void {
    this.idle();
    if (!text.trim()) throw new AgentError("INPUT", "Context note is required");
    const context = normalizeConversationContext(this.session.context);
    const target =
      kind === "decision" ? context.decisions : context.openQuestions;
    target.push({
      id: id(),
      text,
      kind,
      author: "user",
      trusted: true,
      updatedAt: Date.now(),
    });
    this.session.context = context;
    this.save();
  }
  addConstraint(text: string): void {
    this.idle();
    if (!text.trim()) throw new AgentError("INPUT", "Constraint is required");
    const context = normalizeConversationContext(this.session.context);
    context.constraints.push(text);
    this.session.context = context;
    this.save();
  }
  removeConstraint(index: number): void {
    this.idle();
    const context = normalizeConversationContext(this.session.context);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= context.constraints.length
    )
      throw new AgentError("CONTEXT", "Constraint not found");
    context.constraints.splice(index, 1);
    this.session.context = context;
    this.save();
  }
  editPin(noteId: string, text: string): void {
    this.idle();
    const context = normalizeConversationContext(this.session.context);
    const note = context.pins.find(
      (candidate) =>
        candidate.id === noteId &&
        candidate.author === "user" &&
        candidate.trusted,
    );
    if (!note) throw new AgentError("CONTEXT", "User pin not found");
    if (!text.trim()) throw new AgentError("INPUT", "Pin text is required");
    note.text = text;
    note.updatedAt = Date.now();
    this.session.context = context;
    this.save();
  }
  editContextNote(noteId: string, text: string): void {
    this.idle();
    if (!text.trim()) throw new AgentError("INPUT", "Context note is required");
    const context = normalizeConversationContext(this.session.context);
    const note = [
      ...context.pins,
      ...context.decisions,
      ...context.openQuestions,
    ].find(
      (candidate) =>
        candidate.id === noteId &&
        candidate.author === "user" &&
        candidate.trusted,
    );
    if (!note) throw new AgentError("CONTEXT", "User context note not found");
    note.text = text;
    note.updatedAt = Date.now();
    this.session.context = context;
    this.save();
  }
  removePin(noteId: string): void {
    this.idle();
    const context = normalizeConversationContext(this.session.context);
    const before = context.pins.length;
    context.pins = context.pins.filter(
      (note) => note.id !== noteId || note.author !== "user" || !note.trusted,
    );
    if (context.pins.length === before)
      throw new AgentError("CONTEXT", "User pin not found");
    this.session.context = context;
    this.save();
  }
  contextDetails(): string {
    const context = normalizeConversationContext(this.session.context);
    return JSON.stringify(
      {
        pins: context.pins.filter(
          (note) => note.author === "user" && note.trusted,
        ),
        decisions: context.decisions.filter(
          (note) => note.author === "user" && note.trusted,
        ),
        openQuestions: context.openQuestions.filter(
          (note) => note.author === "user" && note.trusted,
        ),
        constraints: context.constraints,
        compactions: context.compactions,
        imageIds: context.imageIds,
        sourceIds: context.sourceIds,
        workingState: context.workingState,
        instructionCount: context.instructions.length,
        originalExcerpts: context.instructions
          .slice(-50)
          .map((instruction) => ({
            seq: instruction.seq,
            role: instruction.role,
            text: instruction.text.slice(0, 200),
            runId: instruction.runId,
          })),
      },
      null,
      2,
    );
  }
  contextOriginal(seq: number, start = 0, bytes = 32_000): string {
    const instruction = normalizeConversationContext(
      this.session.context,
    ).instructions.find((item) => item.seq === seq);
    if (!instruction)
      throw new AgentError(
        "CONTEXT",
        "Original conversation excerpt not found",
      );
    if (
      !Number.isInteger(start) ||
      start < 0 ||
      !Number.isInteger(bytes) ||
      bytes < 1 ||
      bytes > 32_000
    )
      throw new AgentError("CONTEXT", "Original excerpt range is invalid");
    return Buffer.from(instruction.text)
      .subarray(start, start + bytes)
      .toString("utf8");
  }
  async readContext(
    archiveId: string,
    start = 0,
    bytes = 32_000,
  ): Promise<string> {
    this.idle();
    if (this.session.context?.excludedSourceIds?.length)
      throw new AgentError(
        "SOURCE_EXCLUDED",
        "Context archives are unavailable after source exclusion",
      );
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > 32_000
    )
      throw new AgentError(
        "CONTEXT_ARCHIVE",
        "Context archive range is invalid",
      );
    const runIds = this.conversations.runs(this.session.id);
    for (const runId of runIds) {
      try {
        const content = await readContextArchive(
          this.paths,
          this.store.get(runId),
          archiveId,
          bytes,
          start,
        );
        return content;
      } catch (error) {
        if (error instanceof AgentError && error.code === "CONTEXT_ARCHIVE")
          continue;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    throw new AgentError(
      "CONTEXT_ARCHIVE",
      "Context archive is not in this conversation",
    );
  }
  private conversationArtifacts(): Map<
    string,
    { artifact: Artifact; run: Run }
  > {
    const result = new Map<string, { artifact: Artifact; run: Run }>();
    for (const runId of this.conversations.runs(this.session.id)) {
      const run = this.store.get(runId);
      for (const artifact of this.store.artifacts(runId))
        result.set(artifact.id, { artifact, run });
    }
    return result;
  }
  private async sourceFamily(sourceId: string): Promise<{
    sourceIds: string[];
    rawArtifactIds: string[];
    imageIds: string[];
    hashes: string[];
    urls: string[];
  }> {
    const authorized = this.conversationArtifacts(),
      source = authorized.get(sourceId);
    if (!source || source.artifact.kind !== "source")
      throw new AgentError(
        "SOURCE",
        "Source is not authorized in this conversation",
      );
    const runs = this.conversations
      .runs(this.session.id)
      .map((runId) => this.store.get(runId));
    const sourceArtifacts = [...authorized.values()].filter(
      ({ artifact }) => artifact.kind === "source",
    );
    const allImages = [
      ...runs.flatMap((run) => run.images ?? []),
      ...(this.session.images ?? []),
      ...this.session.queue.flatMap((item) => item.images ?? []),
    ];
    const images = new Map(allImages.map((image) => [image.id, image]));
    const documents = new Map<
      string,
      { reference: DocumentReference; images: ImageReference[] }
    >();
    const loadReference = async (reference: DocumentReference) => {
      const loaded = await loadPreparedInput(this.paths, reference);
      const existing = documents.get(reference.id);
      if (existing) {
        if (
          existing.reference.rawSha256 !== reference.rawSha256 ||
          existing.reference.selectedSha256 !== reference.selectedSha256
        )
          throw new AgentError(
            "INPUT_INTEGRITY",
            "Prepared attachment references disagree",
          );
        return;
      }
      documents.set(reference.id, {
        reference: loaded.reference,
        images: (reference.imageIds ?? [])
          .map((id) => images.get(id))
          .filter((image): image is ImageReference => image !== undefined),
      });
    };
    for (const run of runs)
      for (const reference of run.preparedInputs ?? [])
        await loadReference(reference);
    for (const item of this.session.queue)
      for (const reference of item.documents ?? [])
        await loadReference(reference);
    const verified = new Map<
      string,
      { hashes: Set<string>; urls: Set<string>; rawIds: Set<string> }
    >();
    for (const candidate of sourceArtifacts) {
      const content = await this.store.content(candidate.artifact);
      const selectedHash = sha256(content);
      const declaredSelected = candidate.artifact.metadata.selectedSha256;
      if (declaredSelected !== undefined && declaredSelected !== selectedHash)
        throw new AgentError(
          "SOURCE_INTEGRITY",
          "Stored source selected hash does not match its content",
        );
      const hashes = new Set([candidate.artifact.sha256, selectedHash]);
      const rawIds = new Set<string>();
      const rawId = candidate.artifact.metadata.rawArtifactId;
      if (typeof rawId === "string") {
        const raw = authorized.get(rawId);
        if (!raw || raw.artifact.kind !== "source-raw")
          throw new AgentError(
            "SOURCE_INTEGRITY",
            "Stored source raw companion is unavailable",
          );
        const rawContent = await this.store.content(raw.artifact);
        const rawHash = sha256(rawContent);
        if (
          rawHash !== raw.artifact.sha256 ||
          rawHash !== candidate.artifact.metadata.rawSha256
        )
          throw new AgentError(
            "SOURCE_INTEGRITY",
            "Stored source raw companion hash does not match its content",
          );
        hashes.add(rawHash);
        rawIds.add(rawId);
      }
      verified.set(candidate.artifact.id, {
        hashes,
        rawIds,
        urls: new Set(
          [
            candidate.artifact.metadata.url,
            candidate.artifact.metadata.requestedUrl,
          ].filter(
            (url): url is string => typeof url === "string" && url.length > 0,
          ),
        ),
      });
    }
    const sourceIds = new Set<string>([sourceId]);
    const hashes = new Set<string>();
    const urls = new Set<string>();
    const rawArtifactIds = new Set<string>();
    const imageIds = new Set<string>();
    const documentIds = new Set<string>();
    const addSource = (id: string) => {
      const info = verified.get(id);
      if (!info || sourceIds.has(id)) return false;
      sourceIds.add(id);
      for (const hash of info.hashes) hashes.add(hash);
      for (const url of info.urls) urls.add(url);
      for (const rawId of info.rawIds) rawArtifactIds.add(rawId);
      const documentId = sourceArtifacts.find(
        ({ artifact }) => artifact.id === id,
      )?.artifact.metadata.sourceId;
      if (typeof documentId === "string") documentIds.add(documentId);
      return true;
    };
    for (const hash of verified.get(sourceId)!.hashes) hashes.add(hash);
    for (const url of verified.get(sourceId)!.urls) urls.add(url);
    for (const rawId of verified.get(sourceId)!.rawIds)
      rawArtifactIds.add(rawId);
    if (typeof source.artifact.metadata.sourceId === "string")
      documentIds.add(source.artifact.metadata.sourceId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of sourceArtifacts) {
        const info = verified.get(candidate.artifact.id)!;
        const associatedDocument =
          typeof candidate.artifact.metadata.sourceId === "string" &&
          documentIds.has(candidate.artifact.metadata.sourceId);
        if (
          !sourceIds.has(candidate.artifact.id) &&
          (associatedDocument ||
            [...info.hashes].some((hash) => hashes.has(hash)) ||
            [...info.urls].some((url) => urls.has(url)))
        )
          changed = addSource(candidate.artifact.id) || changed;
      }
      for (const [id, document] of documents) {
        const associatedSource = sourceArtifacts.some(
          ({ artifact }) =>
            artifact.metadata.sourceId === id && sourceIds.has(artifact.id),
        );
        if (
          !documentIds.has(id) &&
          (associatedSource ||
            hashes.has(document.reference.rawSha256) ||
            hashes.has(document.reference.selectedSha256))
        ) {
          documentIds.add(id);
          hashes.add(document.reference.rawSha256);
          hashes.add(document.reference.selectedSha256);
          for (const image of document.images) imageIds.add(image.id);
          changed = true;
        }
      }
      for (const image of images.values()) {
        if (
          !imageIds.has(image.id) &&
          ((typeof image.sourceId === "string" &&
            sourceIds.has(image.sourceId)) ||
            (typeof image.documentId === "string" &&
              documentIds.has(image.documentId)) ||
            hashes.has(image.sha256))
        ) {
          imageIds.add(image.id);
          hashes.add(image.sha256);
          changed = true;
        }
      }
      if (
        sourceIds.size +
          rawArtifactIds.size +
          imageIds.size +
          documentIds.size +
          hashes.size +
          urls.size >
        1000
      )
        throw new AgentError(
          "SOURCE_FAMILY_LIMIT",
          "Source family is too large to exclude safely",
        );
    }
    for (const id of documentIds) sourceIds.add(id);
    return {
      sourceIds: [...sourceIds],
      rawArtifactIds: [...rawArtifactIds],
      imageIds: [...imageIds],
      hashes: [...hashes],
      urls: [...urls],
    };
  }
  async previewSourceExclusion(sourceId: string): Promise<{
    sessionId: string;
    sourceId: string;
    family: Awaited<ReturnType<Application["sourceFamily"]>>;
    policy: {
      excludedSourceIds: string[];
      excludedSourceHashes: string[];
      excludedSourceUrls: string[];
    };
    binding: string;
    warning: string;
  }> {
    this.idle();
    const family = await this.sourceFamily(sourceId);
    const policy = {
      excludedSourceIds: [
        ...(this.session.context?.excludedSourceIds ?? []),
      ].sort(),
      excludedSourceHashes: [
        ...(this.session.context?.excludedSourceHashes ?? []),
      ].sort(),
      excludedSourceUrls: [
        ...(this.session.context?.excludedSourceUrls ?? []),
      ].sort(),
    };
    const binding = sha256(
      canonical({
        sessionId: this.session.id,
        sourceId,
        family,
        policy,
      }),
    );
    return {
      sessionId: this.session.id,
      sourceId,
      family: structuredClone(family),
      policy,
      binding,
      warning:
        "Exclusion is forward-only; previously transmitted facts and remote data are not erased.",
    };
  }
  async excludeSource(sourceId: string, binding: string): Promise<void> {
    this.idle();
    const preview = await this.previewSourceExclusion(sourceId);
    if (preview.sessionId !== this.session.id || preview.binding !== binding)
      throw new AgentError(
        "SOURCE_BINDING",
        "Source exclusion preview is stale; create a fresh preview",
      );
    const context = normalizeConversationContext(this.session.context),
      excludedIds = new Set([
        ...(context.excludedSourceIds ?? []),
        ...preview.family.sourceIds,
        ...preview.family.rawArtifactIds,
        ...preview.family.imageIds,
      ]),
      excludedHashes = new Set([
        ...(context.excludedSourceHashes ?? []),
        ...preview.family.hashes,
      ]),
      excludedUrls = new Set([
        ...(context.excludedSourceUrls ?? []),
        ...preview.family.urls,
      ]);
    context.excludedSourceIds = [...excludedIds].sort();
    context.excludedSourceHashes = [...excludedHashes].sort();
    context.excludedSourceUrls = [...excludedUrls].sort();
    context.sourceIds = context.sourceIds.filter((id) => !excludedIds.has(id));
    context.imageIds = context.imageIds.filter((id) => !excludedIds.has(id));
    context.workingState.artifacts = context.workingState.artifacts.filter(
      (id) => !excludedIds.has(id),
    );
    if (context.researchCheckpoint) {
      const unavailableSourceIds = new Set([
        ...(context.researchCheckpoint.unavailableSourceIds ?? []),
        ...preview.family.sourceIds,
      ]);
      context.researchCheckpoint = {
        ...context.researchCheckpoint,
        decisions: context.researchCheckpoint.decisions.map((decision) => ({
          ...decision,
          sourceIds: decision.sourceIds.filter((id) => !excludedIds.has(id)),
        })),
        unavailableSourceIds: [...unavailableSourceIds].sort(),
      };
    }
    for (const [path, hash] of Object.entries(context.workingState.hashes))
      if (excludedHashes.has(hash)) delete context.workingState.hashes[path];
    context.workingState.history = context.workingState.history.map(
      (entry) => ({
        ...entry,
        artifacts: entry.artifacts.filter((id) => !excludedIds.has(id)),
        hashes: Object.fromEntries(
          Object.entries(entry.hashes).filter(
            ([, hash]) => !excludedHashes.has(hash),
          ),
        ),
      }),
    );
    this.session.images = this.session.images?.filter(
      (image) =>
        !excludedIds.has(image.id) && !excludedHashes.has(image.sha256),
    );
    this.session.queue = this.session.queue.map((queued) => {
      const documents = queued.documents?.filter(
        (document) =>
          !excludedIds.has(document.id) &&
          !excludedHashes.has(document.rawSha256) &&
          !excludedHashes.has(document.selectedSha256),
      );
      const images = queued.images?.filter(
        (image) =>
          !excludedIds.has(image.id) && !excludedHashes.has(image.sha256),
      );
      const changed =
        documents?.length !== queued.documents?.length ||
        images?.length !== queued.images?.length;
      return changed
        ? {
            ...queued,
            documents,
            images,
            previewBinding: undefined,
            previewConfigHash: undefined,
            previewDataClass: undefined,
            previewLocalOnly: undefined,
            previewKind: undefined,
            previewModel: undefined,
            previewReviewer: undefined,
            previewStrategy: undefined,
            previewAccess: undefined,
            previewAccessOverride: undefined,
          }
        : { ...queued, documents, images };
    });
    this.session.context = context;
    this.session.contextRunId = undefined;
    this.session.handoff = undefined;
    this.session.handoffDigest = undefined;
    this.save();
  }
  async artifactHistory(
    name?: string,
    offset = 0,
  ): Promise<ArtifactHistoryEntry[]> {
    this.idle();
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000)
      throw new AgentError("ARTIFACT", "Artifact history range is invalid");
    const authorized = this.conversationArtifacts();
    const savedAt = new Map<string, number>();
    for (const runId of this.conversations.runs(this.session.id)) {
      const rows = this.store.db
        .prepare(
          "SELECT seq,detail FROM events WHERE run_id=? AND type='artifact_saved'",
        )
        .all(runId) as { seq: number; detail: string }[];
      for (const row of rows) {
        const detail = JSON.parse(row.detail) as { artifactId?: unknown };
        if (typeof detail.artifactId === "string")
          savedAt.set(detail.artifactId, row.seq);
      }
    }
    const entries = [...authorized.values()]
      .filter(
        ({ artifact }) =>
          artifact.kind === "document" &&
          (name === undefined || artifact.name === name),
      )
      .sort(
        (a, b) =>
          (savedAt.get(b.artifact.id) ?? 0) - (savedAt.get(a.artifact.id) ?? 0),
      )
      .slice(offset, offset + 30);
    for (const { artifact } of entries) {
      if (artifact.bytes > this.config.limits.maxFileBytes)
        throw new AgentError(
          "ARTIFACT_SIZE",
          "Artifact history contains a document above the read limit",
        );
      await this.store.content(artifact);
    }
    return entries.map(({ artifact, run }) => ({
      artifact,
      run: { id: run.id, state: run.state },
      provenanceId: [...authorized.values()].find(
        ({ artifact: candidate }) =>
          candidate.kind === "report" &&
          candidate.metadata.type === "provenance" &&
          candidate.metadata.documentId === artifact.id,
      )?.artifact.id,
    }));
  }
  async artifactProvenance(artifactId: string): Promise<ArtifactProvenance> {
    this.idle();
    const authorized = this.conversationArtifacts();
    const document = authorized.get(artifactId);
    if (!document || document.artifact.kind !== "document")
      throw new AgentError("ARTIFACT", "Artifact is not authorized");
    if (document.artifact.bytes > this.config.limits.maxFileBytes)
      throw new AgentError("ARTIFACT_SIZE", "Document exceeds the read limit");
    await this.store.content(document.artifact);
    const record = [...authorized.values()].find(
      ({ artifact }) =>
        artifact.kind === "report" &&
        artifact.metadata.type === "provenance" &&
        artifact.metadata.documentId === artifactId,
    );
    if (!record)
      return {
        legacy: true,
        artifactId,
        artifactSha256: document.artifact.sha256,
        status: "unknown",
      };
    if (record.artifact.bytes > this.config.limits.maxFileBytes)
      throw new AgentError(
        "ARTIFACT_SIZE",
        "Provenance record exceeds the read limit",
      );
    const parsed = JSON.parse(
      (await this.store.content(record.artifact)).toString("utf8"),
    ) as Record<string, unknown>;
    const validation =
      typeof parsed.validationArtifactId === "string"
        ? authorized.get(parsed.validationArtifactId)
        : undefined;
    const sourceIds = parsed.availableInputSourceIds;
    const citedRanges = parsed.citedSourceRanges;
    const unavailableIds = parsed.unavailableCitedSourceIds;
    const parentRunId = parsed.parentRunId;
    if (
      parsed.version !== 1 ||
      parsed.type !== "provenance" ||
      parsed.documentId !== artifactId ||
      parsed.artifactId !== artifactId ||
      parsed.artifactSha256 !== document.artifact.sha256 ||
      typeof parsed.producingRunId !== "string" ||
      parsed.producingRunId !== document.run.id ||
      (parentRunId !== undefined && typeof parentRunId !== "string") ||
      !Array.isArray(sourceIds) ||
      !sourceIds.every((sourceId) => typeof sourceId === "string") ||
      !Array.isArray(citedRanges) ||
      !citedRanges.every(
        (range): range is ArtifactProvenanceSourceRange =>
          !!range &&
          typeof range === "object" &&
          typeof (range as Record<string, unknown>).sourceId === "string" &&
          Number.isSafeInteger((range as Record<string, unknown>).startLine) &&
          Number.isSafeInteger((range as Record<string, unknown>).endLine) &&
          Number((range as Record<string, unknown>).startLine) > 0 &&
          Number((range as Record<string, unknown>).endLine) >=
            Number((range as Record<string, unknown>).startLine),
      ) ||
      !Array.isArray(unavailableIds) ||
      !unavailableIds.every((sourceId) => typeof sourceId === "string") ||
      parsed.semanticCorrectness !== "not-established" ||
      typeof parsed.validationArtifactId !== "string" ||
      !validation ||
      validation.artifact.kind !== "check" ||
      validation.run.id !== document.run.id ||
      (parentRunId ?? undefined) !== document.run.parentRunId
    )
      throw new AgentError(
        "ARTIFACT_CORRUPT",
        "Provenance does not match artifact",
      );
    const availableInputSourceIds = sourceIds as string[],
      availableSources = new Set(
        [...authorized.values()]
          .filter(
            ({ artifact, run }) =>
              artifact.kind === "source" && run.id === document.run.id,
          )
          .map(({ artifact }) => artifact.id),
      ),
      citedSourceRanges = citedRanges as ArtifactProvenanceSourceRange[];
    const unavailableCitedSourceIds = [
      ...new Set(unavailableIds as string[]),
    ].filter((sourceId) => !availableSources.has(sourceId));
    if (
      new Set(availableInputSourceIds).size !==
        availableInputSourceIds.length ||
      availableInputSourceIds.some(
        (sourceId) => !availableSources.has(sourceId),
      ) ||
      unavailableCitedSourceIds.length !== unavailableIds.length ||
      citedSourceRanges.some(
        (range) =>
          !availableInputSourceIds.includes(range.sourceId) &&
          !unavailableCitedSourceIds.includes(range.sourceId),
      )
    )
      throw new AgentError(
        "ARTIFACT_CORRUPT",
        "Provenance references an unavailable source",
      );
    if (validation.artifact.bytes > this.config.limits.maxFileBytes)
      throw new AgentError(
        "ARTIFACT_SIZE",
        "Validation record exceeds the read limit",
      );
    const checks = JSON.parse(
      (await this.store.content(validation.artifact)).toString("utf8"),
    ) as unknown;
    if (
      !Array.isArray(checks) ||
      !checks.every(
        (check): check is ArtifactValidationCheck =>
          !!check &&
          typeof check === "object" &&
          typeof (check as Record<string, unknown>).id === "string" &&
          typeof (check as Record<string, unknown>).passed === "boolean" &&
          typeof (check as Record<string, unknown>).detail === "string",
      )
    )
      throw new AgentError(
        "ARTIFACT_CORRUPT",
        "Validation record is malformed",
      );
    return {
      status: "available",
      legacy: false,
      version: 1,
      type: "provenance",
      documentId: artifactId,
      artifactId,
      artifactSha256: document.artifact.sha256,
      producingRunId: document.run.id,
      ...(parentRunId === undefined ? {} : { parentRunId }),
      availableInputSourceIds,
      citedSourceRanges,
      unavailableCitedSourceIds,
      validation: {
        artifactId: validation.artifact.id,
        sha256: validation.artifact.sha256,
        checks,
      },
      semanticCorrectness: "not-established",
    };
  }
  async artifactDiff(
    beforeId: string,
    afterId: string,
  ): Promise<{ beforeId: string; afterId: string; patch: string }> {
    this.idle();
    const authorized = this.conversationArtifacts(),
      before = authorized.get(beforeId),
      after = authorized.get(afterId);
    if (
      !before ||
      !after ||
      before.artifact.kind !== "document" ||
      after.artifact.kind !== "document"
    )
      throw new AgentError(
        "ARTIFACT",
        "Both artifacts must be authorized documents",
      );
    const maxBytes = Math.min(this.config.limits.maxFileBytes, 5_000_000);
    if (before.artifact.bytes > maxBytes || after.artifact.bytes > maxBytes)
      throw new AgentError(
        "DIFF_LIMIT",
        "Document diff exceeds the byte limit",
      );
    const [oldBytes, newBytes] = await Promise.all([
      this.store.content(before.artifact),
      this.store.content(after.artifact),
    ]);
    if (oldBytes.length > maxBytes || newBytes.length > maxBytes)
      throw new AgentError(
        "DIFF_LIMIT",
        "Document diff exceeds the byte limit",
      );
    let oldText: string;
    let newText: string;
    try {
      const decoder = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      });
      oldText = decoder.decode(oldBytes);
      newText = decoder.decode(newBytes);
    } catch {
      throw new AgentError(
        "DIFF_ENCODING",
        "Document diff requires UTF-8 text",
      );
    }
    if (oldBytes.includes(0) || newBytes.includes(0))
      throw new AgentError(
        "DIFF_ENCODING",
        "Document diff requires UTF-8 text rather than binary content",
      );
    const patch = createTwoFilesPatch(
      `a/${before.artifact.name}`,
      `b/${after.artifact.name}`,
      oldText,
      newText,
      "",
      "",
      { context: 3, timeout: 250, maxEditLength: 20_000 },
    );
    if (patch === undefined || Buffer.byteLength(patch) > maxBytes)
      throw new AgentError(
        "DIFF_LIMIT",
        "Document diff exceeded the resource limit",
      );
    return { beforeId, afterId, patch };
  }
  async compact(): Promise<void> {
    this.idle();
    const runId = this.session.contextRunId ?? this.session.latestRunId;
    if (!runId) return;
    this.store.assertIdle(runId);
    const run = this.store.get(runId);
    const executedWorker = [...run.tasks]
      .reverse()
      .find(
        (task) =>
          task.role === "worker" && task.state === "succeeded" && task.model,
      );
    const selectedAlias = executedWorker?.model;
    const selected = selectedAlias
      ? this.config.models[selectedAlias]
      : undefined;
    if (!selected)
      throw new AgentError(
        "CONTEXT_LIMIT",
        "No executed worker model is available to establish a context handoff",
      );
    const conversationContext = normalizeConversationContext(
      this.session.context,
    );
    conversationContext.compactions = [];
    const context = {
      conversationContext,
      run: {
        objective: run.objective,
        state: run.state,
        reason: run.reason,
        results: run.tasks.map((t) => ({
          model: t.model,
          summary: t.result?.summary,
          unresolved: t.result?.unresolved,
          author: "model" as const,
          trusted: false as const,
        })),
        artifacts: this.store.artifacts(runId).map((a) => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
          sha256: a.sha256,
        })),
        operations: this.store
          .operations(runId)
          .map(({ id: operationId, task_id, name, status, args_hash }) => ({
            id: operationId,
            taskId: task_id,
            name,
            status,
            argsHash: args_hash,
          })),
        workingCopy: this.session.workRunId,
        checks: run.checks,
      },
    };
    const sourceDigest = sha256(
      canonical({
        model: selectedAlias,
        contextWindow: selected.contextWindow,
        maxOutputTokens: selected.maxOutputTokens,
        context,
      }),
    );
    if (this.session.compacted && this.session.handoffDigest === sourceDigest)
      return;
    const compacted = await compactContext(
      this.paths,
      { ...run, conversationId: this.session.id },
      context,
      {
        config: this.config,
        contextWindow: selected.contextWindow,
        maxOutputTokens: selected.maxOutputTokens,
        trigger: "manual",
        force: true,
      },
    );
    if (!compacted) return;
    this.store.assertIdle(runId);
    const handoff = canonical({
      version: 2,
      sourceDigest,
      runId,
      state: run.state,
      objective: run.objective,
      archiveId: compacted.record.archiveId,
      results: context.run.results,
      artifacts: context.run.artifacts,
      workingCopy: this.session.workRunId,
      checks: run.checks,
    });
    await atomicWrite(join(this.store.runDir(runId), "handoff.json"), handoff);
    const state = normalizeConversationContext(this.session.context);
    state.compactions = [
      ...state.compactions.filter(
        (record) => record.id !== compacted.record.id,
      ),
      compacted.record,
    ];
    state.originalRunIds = [...new Set([...state.originalRunIds, runId])];
    this.session.context = state;
    this.session.compacted = true;
    this.session.handoffDigest = sourceDigest;
    this.session.handoff = handoff;
    this.save();
    this.publish("notice", {
      text: "引き継ぎ情報を保存しました。次の依頼から新しい Pi セッションを使います。原文・出典・検証記録は保持しています。",
    });
  }
  async saveConfiguration(input: unknown): Promise<void> {
    const next = validateConfig(input);
    const release = await lockfile.lock(this.paths.config, {
      stale: 30000,
      retries: 0,
    });
    try {
      const current = await loadConfig(this.paths);
      if (configHash(current) !== configHash(this.config))
        throw new AgentError(
          "CONFIG_CHANGED",
          "設定が外部で変更されました。再起動してから編集してください。",
        );
      await atomicWrite(
        `${this.paths.config}.bak`,
        await readFile(this.paths.config),
      );
      await atomicWrite(this.paths.config, stringify(next));
      this.config = next;
      this.publish("notice", {
        text: "設定を保存しました。次の依頼から適用します。",
      });
    } finally {
      await release();
    }
  }
  async doctor() {
    const directory = await mkdtemp(join(this.paths.home, "doctor-"));
    try {
      const sandbox =
        this.config.execution.backend === "disabled"
          ? { ok: false, detail: "Shell・コード検査は無効です" }
          : await new Sandbox(this.config.execution).probe(directory);
      return {
        node: process.version,
        platform: process.platform,
        sandbox,
        connections: Object.entries(this.config.connections).map(
          ([name, c]) => ({
            name,
            enabled: c.enabled,
            type: c.type,
            allowedData: c.allowedData,
            credential:
              c.type === "chatgpt"
                ? "ログイン状態は /login で確認"
                : c.type === "local" ||
                    (c.secretEnv && process.env[c.secretEnv])
                  ? "present"
                  : `missing: ${c.secretEnv ?? "secretEnv"}`,
            budget:
              c.billing === "api"
                ? this.config.limits.maxApiUsd > 0 && c.maxRequestUsd > 0
                : "subscription/local",
          }),
        ),
        inference: "未実行。/probe で明示的に実行",
        isolation:
          "ネットワークなし。依存は runtimePaths または固定コンテナへ事前準備",
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    try {
      await this.work?.catch(() => {});
    } finally {
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.session) {
        this.conversations.save(this.session);
        this.conversations.release(this.session.id);
      }
    }
  }
  async probe(model: string): Promise<void> {
    this.idle();
    if (!this.config.models[model])
      throw new AgentError("NO_MODEL", "モデルが見つかりません。");
    const config = structuredClone(this.config);
    config.models[model]!.tools = true;
    config.models[model]!.roles = ["worker"];
    config.models[model]!.kinds = ["writing"];
    config.execution.backend = "disabled";
    config.web.allowedHosts = [];
    config.mcp = {};
    config.routing.mode = "rules";
    config.limits.maxRequests = Math.min(config.limits.maxRequests, 6);
    this.busy = true;
    this.controller = new AbortController();
    this.work = (async () => {
      const harness = new Harness(
        config,
        this.paths,
        this.store,
        await this.runtimeFactory(config),
        (type, detail) => this.publish(type, detail),
      );
      const run = await harness.create({
        kind: "writing",
        mode: "single",
        model,
        dataClass: "public",
        objective:
          'Create probe.md containing exactly "Agent connection works." Read it back with read_file. Return it as your artifact.',
        mustKeep: ["Agent connection works."],
      });
      this.activeRunId = run.id;
      this.conversations.link(this.session, run);
      const result = await harness.execute(run.id, this.controller!.signal);
      this.publish("notice", {
        text: `疎通試験: ${result.state} ${result.reason ?? ""}。tools の設定は自動変更していません。`,
      });
    })().finally(() => {
      this.busy = false;
      this.activeRunId = undefined;
      this.publish("changed");
    });
    await this.work;
  }
  currentRun(): Run | undefined {
    return this.session.latestRunId
      ? this.store.get(this.session.latestRunId)
      : undefined;
  }
  async lastValidation(runId = this.session.latestRunId) {
    if (!runId) return undefined;
    // Artifact rows are not ordered. The event sequence identifies the most
    // recently completed validation, including after a repair or restart.
    const saved = this.store.db
      .prepare(
        "SELECT detail FROM events WHERE run_id=? AND type='artifact_saved' AND json_extract(detail,'$.name')='validation.json' AND json_extract(detail,'$.kind')='check' ORDER BY seq DESC LIMIT 1",
      )
      .get(runId) as { detail: string } | undefined;
    if (!saved) return undefined;
    const { artifactId } = JSON.parse(saved.detail) as { artifactId: string };
    return JSON.parse(await this.artifactText(artifactId, runId)) as {
      id: string;
      passed: boolean;
      detail: string;
    }[];
  }
  view(runId = this.session.latestRunId) {
    const run = runId ? this.store.get(runId) : undefined;
    const context =
      run &&
      (this.store.db
        .prepare(
          "SELECT detail FROM events WHERE run_id=? AND type='context_usage' ORDER BY seq DESC LIMIT 1",
        )
        .get(run.id) as { detail: string } | undefined);
    return {
      run,
      context: context
        ? (JSON.parse(context.detail) as {
            bytes: number;
            limit: number;
            model: string;
            taskId: string;
            imageCount: number;
            estimatedImageTokens: number;
            imageUsage?: string;
          })
        : undefined,
      usage: run && this.store.usage(run.id),
      artifacts: run ? this.store.artifacts(run.id) : [],
      operations: run ? this.store.operations(run.id) : [],
    };
  }
  artifactRuns(offset = 0): Run[] {
    return (
      this.store.db
        .prepare(
          "SELECT run_id FROM conversation_runs WHERE session_id=? ORDER BY rowid DESC LIMIT 30 OFFSET ?",
        )
        .all(this.session.id, offset) as { run_id: string }[]
    ).map((row) => this.store.get(row.run_id));
  }
  async artifactText(
    artifactId: string,
    runId = this.session.latestRunId,
  ): Promise<string> {
    if (
      !runId ||
      !this.store.db
        .prepare(
          "SELECT 1 FROM conversation_runs WHERE session_id=? AND run_id=?",
        )
        .get(this.session.id, runId)
    )
      throw new AgentError("ARTIFACT", "この会話の作業を選択してください。");
    const artifact = this.view(runId).artifacts.find(
      (a) => a.id === artifactId,
    );
    if (!artifact)
      throw new AgentError("ARTIFACT", "この作業の成果物が見つかりません。");
    return (await this.store.content(artifact)).toString("utf8");
  }
  history(before?: number) {
    return this.conversations.messages(this.session.id, before);
  }
  sessions(offset = 0) {
    return this.conversations.list(this.session.workspace, offset);
  }
  interrupted(): boolean {
    const run = this.currentRun();
    return !!run && !terminalStates.includes(run.state);
  }
}
