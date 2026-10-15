import { EventEmitter } from "node:events";
import { realpath, readFile, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { stringify } from "yaml";
import lockfile from "proper-lockfile";
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
  type WorkKind,
} from "./types.js";
import {
  atomicWrite,
  canonical,
  errorMessage,
  id,
  readText,
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
} from "./images.js";
import { modelCandidates } from "./policy.js";
import { endpoint } from "./runtime/providers.js";
import { secretPath, workspaceDiff } from "./workspace.js";

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
  }[];
  images: ImageReference[];
  destinations: string[];
  dataClass: DataClass;
  localOnly: boolean;
}
interface InputSnapshot {
  text: string;
  attachments: InputPreview["attachments"];
  images: ImageReference[];
  destinationBinding: string;
  configHash: string;
  dataClass: DataClass;
  localOnly: boolean;
  kind: WorkKind;
  strategy: Run["mode"];
  model?: string;
}
export function inferKind(text: string, previous?: WorkKind): WorkKind {
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
    const fresh: ImageReference[] = [];
    for (const path of fileReferences(text)) {
      if (secretPath(path))
        throw new AgentError(
          "PATH_DENIED",
          "認証・制御ファイルは添付できません。",
        );
      const safe = await safePath(this.session.workspace, path);
      if (isImagePath(path)) {
        const bytes = await readBoundedImage(safe);
        const mimeType = imageMimeForPath(path)!;
        const metadata = await validateImage(bytes, mimeType);
        const imageId = `img-${sha256(bytes)}`;
        const known = new Map(
          [...(this.session.images ?? []), ...fresh].map((ref) => [
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
          basename(path),
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
        attachments.push({ path, bytes: bytes.length, mimeType });
      } else {
        if (await isImageFileSignature(safe))
          throw new AgentError(
            "IMAGE_FORMAT",
            "Image file extension does not match PNG, JPEG, or WebP content",
          );
        const content = await readText(safe, this.config.limits.maxFileBytes);
        const bytes = Buffer.byteLength(content);
        total += bytes;
        attachments.push({ path, bytes });
      }
    }
    if (total > this.config.limits.maxInputBytes)
      throw new AgentError(
        "INPUT_SIZE",
        "依頼と添付ファイルが入力上限を超えています。",
      );
    const allImages = [...(this.session.images ?? [])];
    for (const ref of fresh)
      if (!allImages.some((image) => image.id === ref.id)) allImages.push(ref);
    const unique = new Map(allImages.map((ref) => [ref.id, ref]));
    const images = [...unique.values()];
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
        imageIds: images.map((ref) => ref.id),
      }),
    );
    return {
      text,
      attachments,
      images,
      destinationBinding: binding,
      configHash: configHash(this.config),
      dataClass: disclosure.dataClass,
      localOnly: disclosure.localOnly,
      kind,
      strategy: this.session.strategy,
      model: this.session.model,
    };
  }
  async previewInput(text: string): Promise<InputPreview> {
    const snapshot = await this.snapshotInput(text);
    const destinations = this.imageDestinations(snapshot.images, snapshot);
    const preview: InputPreview = {
      text,
      attachments: structuredClone(snapshot.attachments),
      images: structuredClone(snapshot.images),
      destinations,
      dataClass: snapshot.dataClass,
      localOnly: snapshot.localOnly,
    };
    this.previews.set(preview, snapshot);
    return preview;
  }
  private imageDestinations(
    images: ImageReference[],
    snapshot: Pick<
      InputSnapshot,
      "dataClass" | "localOnly" | "kind" | "attachments" | "strategy" | "model"
    >,
  ): string[] {
    if (!images.length) return [];
    const kind = snapshot.kind;
    const run = {
      kind,
      mode: snapshot.strategy,
      dataClass: snapshot.dataClass,
      localOnly: snapshot.localOnly,
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
      ? ` Authorized image-capable alternatives: ${destinations.join("; ")}.`
      : " No authorized image-capable alternatives are available.";
    const missingRole = requiredRoles.find(
      (role) =>
        !(role === "reviewer" ? reviewerCandidates : candidates[role]).length,
    );
    if (missingRole)
      throw new AgentError(
        "NO_IMAGE_MODEL",
        `No authorized image-capable ${missingRole} model is available for ${kind}/${snapshot.dataClass}${snapshot.localOnly ? "/local-only" : ""}.${alternatives}`,
      );
    if (snapshot.model && !candidates[requestedRole].includes(snapshot.model))
      throw new AgentError(
        "NO_IMAGE_MODEL",
        `Selected model ${snapshot.model} is not an authorized image-capable ${requestedRole} model.${alternatives}`,
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
      preview.dataClass !== snapshot.dataClass ||
      preview.localOnly !== snapshot.localOnly
    )
      throw new AgentError(
        "IMAGE_PREVIEW",
        "Input preview is invalid; review the input again",
      );
    if (
      snapshot.images.length &&
      snapshot.configHash !== configHash(this.config)
    )
      throw new AgentError(
        "IMAGE_PREVIEW_STALE",
        "Configuration changed after preview; review the input and destinations again",
      );
    if (
      canonical(preview.destinations) !==
      canonical(this.imageDestinations(snapshot.images, snapshot))
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
        imageIds: snapshot.images.map((ref) => ref.id),
      }),
    );
    if (
      snapshot.images.length &&
      (currentBinding !== snapshot.destinationBinding ||
        kind !== snapshot.kind ||
        this.session.strategy !== snapshot.strategy ||
        this.session.model !== snapshot.model)
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
  private async textAttachments(
    text: string,
  ): Promise<{ path: string; bytes: number }[]> {
    let total = Buffer.byteLength(text);
    const attachments: { path: string; bytes: number }[] = [];
    for (const path of fileReferences(text)) {
      if (secretPath(path))
        throw new AgentError(
          "PATH_DENIED",
          "認証・制御ファイルは添付できません。",
        );
      if (isImagePath(path)) continue;
      const safe = await safePath(this.session.workspace, path);
      const content = await readText(safe, this.config.limits.maxFileBytes);
      const bytes = Buffer.byteLength(content);
      total += bytes;
      attachments.push({ path, bytes });
    }
    if (total > this.config.limits.maxInputBytes)
      throw new AgentError(
        "INPUT_SIZE",
        "依頼と添付ファイルが入力上限を超えています。",
      );
    return attachments;
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
      previewBinding: snapshot.destinationBinding,
      previewConfigHash: snapshot.configHash,
      previewDataClass: snapshot.dataClass,
      previewLocalOnly: snapshot.localOnly,
      previewKind: snapshot.kind,
      previewModel: snapshot.model,
      previewStrategy: snapshot.strategy,
    };
    if (!this.session.latestRunId && this.session.name === "新しい会話")
      this.session.name = text.split("\n")[0]!;
    this.session.queue.push(item);
    this.session.images = structuredClone(snapshot.images);
    this.session.draft = "";
    this.save();
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
    item.previewBinding = snapshot?.destinationBinding;
    item.previewConfigHash = snapshot?.configHash;
    item.previewDataClass = snapshot?.dataClass;
    item.previewLocalOnly = snapshot?.localOnly;
    item.previewKind = snapshot?.kind;
    item.previewModel = snapshot?.model;
    item.previewStrategy = snapshot?.strategy;
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
    const refs = await this.textAttachments(input.text);
    const retained = new Map(
      (this.session.images ?? []).map((reference) => [reference.id, reference]),
    );
    const images = (input.images ?? this.session.images ?? []).map(
      (reference) => {
        const prior = retained.get(reference.id);
        if (!prior) return reference;
        const levels: DataClass[] = ["public", "private", "restricted"];
        return {
          ...reference,
          dataClass:
            levels.indexOf(prior.dataClass) >
            levels.indexOf(reference.dataClass)
              ? prior.dataClass
              : reference.dataClass,
          localOnly: prior.localOnly || reference.localOnly,
        };
      },
    );
    if (images.length) {
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
        disclosure.dataClass !== input.previewDataClass ||
        disclosure.localOnly !== input.previewLocalOnly
      )
        throw new AgentError(
          "IMAGE_PREVIEW_STALE",
          "Queued image input needs a new preview and confirmation after configuration or privacy changes",
        );
      this.imageDestinations(images, {
        dataClass: disclosure.dataClass,
        localOnly: disclosure.localOnly,
        kind,
        attachments: fileReferences(input.text)
          .filter((path) => !isImagePath(path))
          .map((path) => ({ path, bytes: 0 })),
        strategy: input.previewStrategy!,
        model: input.previewModel,
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
    const contextRun = this.session.contextRunId
      ? this.store.get(this.session.contextRunId)
      : undefined;
    const previousSessions: NonNullable<Run["previousSessions"]> = {};
    if (!this.session.compacted && contextRun?.kind === kind)
      for (const task of contextRun.tasks)
        if (task.sessionFile && task.model)
          previousSessions[task.id] = {
            model: task.model,
            file: task.sessionFile,
          };
    const parentRunId =
      kind === "coding"
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
    // A context handoff carries verified status and references; Pi alone owns model turns.
    const context =
      this.session.handoff ??
      (contextRun
        ? canonical({
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
          })
        : undefined);
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
      workspace: kind === "coding" ? this.session.workspace : undefined,
      parentRunId: usableParent,
      previousSessions,
      context,
      includeUntracked: this.session.includeUntracked,
      model: this.session.model,
      reviewer: this.session.reviewer,
      inputs: refs.map((r) => join(this.session.workspace, r.path)),
      checks: kind === "coding" ? this.session.checks : [],
    });
    this.activeRunId = run.id;
    this.store.transaction(() => {
      this.conversations.link(this.session, run);
      this.session.latestRunId = run.id;
      if (kind === "coding") this.session.workRunId = run.id;
      if (kind === "writing" || kind === "research")
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
    this.session.compacted = false;
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
  async compact(): Promise<void> {
    this.idle();
    const runId = this.session.contextRunId;
    if (!runId) return;
    const run = this.store.get(runId);
    const handoff = canonical({
      objective: run.objective,
      state: run.state,
      reason: run.reason,
      results: run.tasks.map((t) => ({
        model: t.model,
        summary: t.result?.summary,
        unresolved: t.result?.unresolved,
      })),
      artifacts: this.store.artifacts(runId).map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        sha256: a.sha256,
      })),
      workingCopy: this.session.workRunId,
      checks: run.checks,
    });
    await atomicWrite(join(this.store.runDir(runId), "handoff.json"), handoff);
    this.session.compacted = true;
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
