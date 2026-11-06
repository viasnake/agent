import type { Job, Status } from "../src/state.js";
type Summary = Pick<
  Job,
  "id" | "title" | "status" | "waitReason" | "detail" | "revision" | "updatedAt"
>;
type View = {
  job: Job;
  transcript: {
    id: number;
    kind: string;
    messages: { role: string; content: string; toolName?: string }[];
  }[];
  cursor?: Record<string, unknown>;
  progress?: {
    generating: boolean;
    tools: { name: string; status: string; output?: string }[];
  };
};
const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;
const labels: Record<Status, string> = {
  queued: "実行待ち",
  running: "作業中",
  waiting: "確認待ち",
  succeeded: "納品済み",
  failed: "未完了",
  cancelled: "取消済み",
};
let csrf = "",
  current: View | undefined,
  events: EventSource | undefined,
  parentId: string | undefined,
  nextOffset: number | null = null;
let settings: {
  revision: number;
  commonInstructions: string;
  projectNotes: Record<string, string>;
  modelConfigured: boolean;
  model: { id: string } | null;
};
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body
        ? { "Content-Type": "application/json", "X-CSRF-Token": csrf }
        : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    $("connection").textContent =
      "未接続 — VM とサービスの起動を確認してください";
    throw new Error(
      "接続できません。VM・サービス・ポート転送を確認してください。",
    );
  }
  if (response.status === 401) {
    showLogin();
    throw new Error("ログインしてください");
  }
  if (!response.ok) {
    const error = (await response.json()) as { error?: string };
    throw new Error(error.error ?? `処理できません (${response.status})`);
  }
  return response.json() as Promise<T>;
}
async function pendingIdentity(key: string, payload: unknown): Promise<string> {
  const hash = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(payload)),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const storageKey = `agent-pending:${key}:${hash}`;
  const existing = sessionStorage.getItem(storageKey);
  if (existing) return existing;
  const id = crypto.randomUUID();
  sessionStorage.setItem(storageKey, id);
  return id;
}
function clearPending(): void {
  for (const key of Object.keys(sessionStorage))
    if (key.startsWith("agent-pending:")) sessionStorage.removeItem(key);
}
function showLogin(): void {
  $("login").hidden = false;
  $("app").hidden = true;
  events?.close();
}
function showError(error: unknown): void {
  $("error").textContent =
    error instanceof Error ? error.message : "処理に失敗しました";
  $("error").hidden = false;
}
function button(
  label: string,
  run: () => Promise<unknown>,
  cls = "secondary",
): HTMLButtonElement {
  const result = document.createElement("button");
  result.textContent = label;
  result.type = "button";
  result.className = cls;
  result.addEventListener("click", () => {
    result.disabled = true;
    void run()
      .catch(showError)
      .finally(() => {
        result.disabled = false;
      });
  });
  return result;
}
function text(tag: string, value: string, cls?: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = value;
  if (cls) element.className = cls;
  return element;
}
async function loadJobs(append = false): Promise<void> {
  const result = await api<{ jobs: Summary[]; nextOffset: number | null }>(
    `/api/jobs?offset=${append ? (nextOffset ?? 0) : 0}`,
  );
  if (!append) $("jobs").replaceChildren();
  for (const job of result.jobs) {
    const item = button("", () => openJob(job.id), "job-link");
    item.dataset.id = job.id;
    item.append(
      text("strong", job.title),
      text("small", `${labels[job.status]} · ${job.detail.slice(0, 70)}`),
    );
    if (current?.job.id === job.id) item.classList.add("selected");
    $("jobs").append(item);
  }
  nextOffset = result.nextOffset;
  $("more-jobs").hidden = nextOffset === null;
}
async function openJob(id: string): Promise<void> {
  events?.close();
  $("error").hidden = true;
  $("compose").hidden = true;
  $("detail").hidden = false;
  current = await api<View>(`/api/jobs/${id}`);
  render(current);
  events = new EventSource(`/api/jobs/${id}/events`);
  events.addEventListener("snapshot", (event) => {
    const next = JSON.parse((event as MessageEvent<string>).data) as View;
    if (
      next.job.id !== current?.job.id ||
      next.job.revision < current.job.revision
    )
      return;
    current = next;
    render(next);
  });
  events.onerror = () => {
    $("connection").textContent = "進捗の再接続中 — 最後に確認した状態を表示";
  };
  await loadJobs();
}
function render(view: View): void {
  const job = view.job;
  const nav = document.querySelector(`[data-id="${job.id}"] small`);
  if (nav)
    nav.textContent = `${labels[job.status]} · ${job.detail.slice(0, 70)}`;
  $("connection").textContent = "VM に接続中";
  $("job-title").textContent = job.title;
  $("job-state").textContent = labels[job.status];
  $("job-progress").textContent = job.detail;
  $("budget").textContent =
    `モデル呼び出し ${job.counters.modelRequests} / ${job.limits.modelRequests} 回${job.deadlineAt ? `　期限 ${new Date(job.deadlineAt).toLocaleString("ja-JP")}` : ""}　費用は報告分のみ。未確定の使用量は不明です。`;
  $("original").textContent =
    `${job.objective}\n\n完成の条件\n${job.acceptance.map((item) => `・${item}`).join("\n")}`;
  const terminal = ["succeeded", "failed", "cancelled"].includes(job.status);
  $("input-form").hidden = terminal;
  $("continue-job").hidden = !terminal;
  $("input-status").textContent = job.inputs.some((input) => !input.applied)
    ? "受理済み・反映待ちの指示があります"
    : "受理した指示は反映済みです";
  $("actions").replaceChildren();
  const action = async (
    name: "pause" | "resume" | "cancel",
    useConfiguredModel = false,
  ) => {
    if (useConfiguredModel) {
      const configured = await api<typeof settings>("/api/settings");
      if (!configured.modelConfigured)
        throw new Error("切替先モデルを設定してください");
      if (
        !confirm(
          `設定中のモデル ${configured.model?.id ?? ""} に切り替えて再開しますか。残上限と期限は引き継ぎます。`,
        )
      )
        return;
    }
    await api(`/api/jobs/${job.id}/actions`, "POST", {
      requestId: crypto.randomUUID(),
      revision: current!.job.revision,
      action: name,
      useConfiguredModel,
    });
    current = await api<View>(`/api/jobs/${job.id}`);
    render(current);
    await loadJobs();
  };
  if (!terminal) {
    if (job.status === "waiting") {
      $("actions").append(
        button("再開", () => action("resume")),
        button("設定中のモデルで再開", () => action("resume", true)),
      );
    } else $("actions").append(button("一時停止", () => action("pause")));
    $("actions").append(
      button(
        "取消",
        async () => {
          if (
            confirm(
              "この仕事を取り消しますか。発生済みの外部変更は戻りません。",
            )
          )
            await action("cancel");
        },
        "danger",
      ),
    );
  }
  $("artifacts").replaceChildren();
  const latest = new Map(
    job.artifacts.map((artifact) => [artifact.name, artifact]),
  );
  const records = document.createElement("details");
  records.className = "records";
  records.append(text("summary", "検証・取得の記録ファイル"));
  for (const artifact of latest.values()) {
    const link = document.createElement("a");
    link.className = "artifact";
    link.href = `/api/artifacts/${artifact.id}/download`;
    link.download = artifact.name;
    link.append(
      text("span", artifact.name),
      text(
        "small",
        `v${artifact.version} · ${(artifact.size / 1024).toFixed(1)} KiB`,
      ),
    );
    if (
      /^(command-|self-review-|source-|pdf-inspection-)/.test(artifact.name)
    ) {
      records.append(link);
    } else $("artifacts").append(link);
  }
  if (records.children.length > 1) $("artifacts").append(records);
  if (!latest.size)
    $("artifacts").append(
      text("p", "納品されたファイルはまだありません。", "subtle"),
    );
  $("validations").replaceChildren();
  for (const validation of job.validations.slice(-20)) {
    const details = document.createElement("details");
    details.append(
      text(
        "summary",
        `${validation.kind === "command" ? "コマンド検証" : validation.kind === "render" ? "PDF 機械検査" : "自己レビュー"} · ${validation.exitCode === 0 ? "実施済み" : `終了 ${validation.exitCode}`}${validation.workspaceRevision !== job.workspaceRevision ? "（過去の版）" : ""}`,
      ),
      text("pre", validation.command),
    );
    const a = document.createElement("a");
    a.href = `/api/artifacts/${validation.logArtifactId}/download`;
    a.textContent = "元の記録を取得";
    details.append(a);
    $("validations").append(details);
  }
  if (!job.validations.length)
    $("validations").append(
      text("p", "検証はまだ実施されていません。", "subtle"),
    );
  $("transcript").replaceChildren();
  appendTranscript([...view.transcript].reverse());
  $("earlier").hidden = !view.cursor;
  $("live").textContent =
    view.progress?.tools
      .map((tool) => `${tool.name}: ${tool.status}`)
      .join(" · ") ||
    (view.progress?.generating ? "モデルが応答を作成しています" : "");
  renderDecisions(job);
}
function appendTranscript(entries: View["transcript"], before = false): void {
  const fragment = document.createDocumentFragment();
  for (const entry of entries)
    for (const message of entry.messages) {
      const row = text("article", "", "message");
      row.append(
        text(
          "strong",
          message.role === "user"
            ? "あなた"
            : message.role === "assistant"
              ? "Agent"
              : "実行記録",
        ),
      );
      if (message.toolName || message.role === "toolResult") {
        const names: Record<string, string> = {
          read_file: "ファイルを確認",
          write_file: "ファイルを保存",
          shell: "コマンドを実行",
          validate_command: "検証コマンドを実行",
          make_patch: "差分を作成",
          publish_artifact: "成果物を保存",
          fetch_source: "資料を取得",
          browser: "ブラウザーで確認",
          render_document: "PDF を生成・検査",
          inspect_image: "画像を確認",
          self_review: "自己レビューを記録",
          finish_job: "完了条件を確認",
          ask_user: "確認を依頼",
          propose_github: "GitHub 変更を提案",
        };
        const details = document.createElement("details");
        details.append(
          text(
            "summary",
            `${names[message.toolName ?? ""] ?? "作業を実行"}${message.role === "toolResult" ? " — 結果" : ""}`,
          ),
          text("pre", message.content),
        );
        row.append(details);
      } else if (message.content.length > 1200) {
        const details = document.createElement("details");
        details.append(
          text("summary", message.content.slice(0, 160)),
          text("pre", message.content),
        );
        row.append(details);
      } else row.append(text("p", message.content));
      fragment.append(row);
    }
  if (before) $("transcript").prepend(fragment);
  else $("transcript").append(fragment);
}
function renderDecisions(job: Job): void {
  $("decisions").replaceChildren();
  for (const operation of job.operations.filter(
    (op) =>
      (op.status === "prepared" && op.kind === "github") ||
      op.status === "unknown",
  )) {
    const panel = text("div", "", "decision");
    panel.append(
      text(
        "h2",
        operation.status === "unknown"
          ? "結果の照合が必要です"
          : "GitHub への送信を確認",
      ),
      text("p", `${operation.kind} · ${operation.target}`),
    );
    const details = document.createElement("details");
    details.append(
      text("summary", "対象・内容を表示"),
      text(
        "pre",
        JSON.stringify(
          operation.payload ?? { argumentHash: operation.argumentHash },
          null,
          2,
        ),
      ),
    );
    panel.append(details);
    if (operation.status === "prepared")
      for (const approved of [true, false])
        panel.append(
          button(
            approved ? "この内容で下書き PR を作成" : "拒否",
            async () => {
              await api(`/api/jobs/${job.id}/approvals`, "POST", {
                requestId: crypto.randomUUID(),
                revision: current!.job.revision,
                operationId: operation.id,
                approved,
              });
            },
            approved ? "" : "secondary",
          ),
        );
    else {
      const evidence = document.createElement("textarea");
      evidence.placeholder =
        "確認した外部状態・コマンド・ログなどの根拠（8文字以上）";
      panel.append(evidence);
      const choices =
        operation.kind === "github"
          ? [
              ["GitHub の既存 PR を照合", "check_github"],
              ["実行済みと確認", "completed"],
              ["未実行と確認", "not_executed"],
            ]
          : [
              ["結果を確認して記録", "completed"],
              ["未実行と確認", "not_executed"],
            ];
      for (const [label, resolution] of choices)
        panel.append(
          button(label!, async () => {
            await api(`/api/jobs/${job.id}/reconciliations`, "POST", {
              requestId: crypto.randomUUID(),
              revision: current!.job.revision,
              operationId: operation.id,
              resolution,
              evidence: evidence.value,
            });
          }),
        );
    }
    $("decisions").append(panel);
  }
  if (job.recoveryRequired) {
    const panel = text("div", "", "decision"),
      evidence = document.createElement("textarea");
    evidence.placeholder =
      "復元・前回終了時の外部状態を確認した根拠（8文字以上）";
    panel.append(
      text("h2", "復旧後の実行を保留しています"),
      evidence,
      button("確認結果を記録", async () => {
        await api(`/api/jobs/${job.id}/reconciliations`, "POST", {
          requestId: crypto.randomUUID(),
          revision: current!.job.revision,
          operationId: "recovery-hold",
          resolution: "acknowledge_recovery",
          evidence: evidence.value,
        });
      }),
    );
    $("decisions").append(panel);
  }
  if (job.waitReason === "budget") {
    if (job.counters.modelRequests >= job.limits.modelRequests)
      $("decisions").append(
        button("呼び出し上限を10回増やして再開", async () => {
          if (
            confirm(
              "追加のモデル利用に同意して再開しますか。利用料金が発生する場合があります。",
            )
          )
            await api(`/api/jobs/${job.id}/actions`, "POST", {
              requestId: crypto.randomUUID(),
              revision: current!.job.revision,
              action: "resume",
              additionalModelRequests: 10,
              extensionSeconds: 3600,
            });
        }),
      );
    $("decisions").append(
      button("期限を1時間延長して再開", async () => {
        await api(`/api/jobs/${job.id}/actions`, "POST", {
          requestId: crypto.randomUUID(),
          revision: current!.job.revision,
          action: "resume",
          extensionSeconds: 3600,
        });
      }),
    );
  }
}
$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const result = await api<{ csrf: string }>("/api/login", "POST", {
      requestId: crypto.randomUUID(),
      password: $<HTMLInputElement>("password").value,
    });
    csrf = result.csrf;
    $<HTMLInputElement>("password").value = "";
    await boot();
  })().catch((error) => {
    $("login-error").textContent = (error as Error).message;
  });
});
$("new-job").addEventListener("click", () => {
  events?.close();
  current = undefined;
  parentId = undefined;
  $("compose").hidden = false;
  $("detail").hidden = true;
  $("error").hidden = true;
});
$("job-form").addEventListener("submit", (event) => {
  event.preventDefault();
  $<HTMLButtonElement>("submit-job").disabled = true;
  void (async () => {
    const ids: string[] = [],
      files = [...($<HTMLInputElement>("attachments").files ?? [])];
    if (
      files.some((file) => file.size > 20 * 1024 * 1024) ||
      files.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024
    )
      throw new Error("添付サイズが上限を超えています");
    for (const file of files) {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      ids.push(
        (
          await api<{ id: string }>("/api/uploads", "POST", {
            requestId: await pendingIdentity(`upload:${file.name}`, {
              name: file.name,
              data,
            }),
            name: file.name,
            data,
          })
        ).id,
      );
    }
    const kind = $<HTMLSelectElement>("kind").value,
      acceptance = $<HTMLTextAreaElement>("acceptance")
        .value.split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    const input = {
      title: $<HTMLInputElement>("title").value,
      objective: $<HTMLTextAreaElement>("objective").value,
      kind,
      acceptance: acceptance.length
        ? acceptance
        : kind === "code"
          ? ["変更差分", "機械検証", "自己レビュー"]
          : ["出典記録", "Markdown", "日本語PDF", "描画確認", "自己レビュー"],
      project: $<HTMLInputElement>("project").value,
      repoUrl: $<HTMLInputElement>("repo-url").value || undefined,
      attachmentIds: ids,
      externalAllowed: $<HTMLInputElement>("external-allowed").checked,
      parentId,
    };
    const result = await api<{ id: string }>("/api/jobs", "POST", {
      ...input,
      requestId: await pendingIdentity("job", input),
    });
    clearPending();
    $<HTMLFormElement>("job-form").reset();
    parentId = undefined;
    await openJob(result.id);
  })()
    .catch(showError)
    .finally(() => {
      $<HTMLButtonElement>("submit-job").disabled = false;
    });
});
$("input-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void api(`/api/jobs/${current!.job.id}/inputs`, "POST", {
    requestId: crypto.randomUUID(),
    text: $<HTMLTextAreaElement>("input-text").value,
  })
    .then(() => {
      $<HTMLTextAreaElement>("input-text").value = "";
      $("input-status").textContent =
        "受理しました。次の安全な境界で反映します。";
    })
    .catch(showError);
});
$("continue-job").addEventListener("click", () => {
  if (!current) return;
  parentId = current.job.id;
  $<HTMLSelectElement>("kind").value = current.job.kind;
  $<HTMLInputElement>("project").value = current.job.project;
  $<HTMLInputElement>("repo-url").value = current.job.repoUrl ?? "";
  $<HTMLTextAreaElement>("acceptance").value =
    current.job.acceptance.join("\n");
  $<HTMLInputElement>("external-allowed").checked = false;
  $<HTMLInputElement>("title").value = `${current.job.title} の続き`;
  $<HTMLTextAreaElement>("objective").value =
    `元の依頼: ${current.job.objective}\n\n続きの依頼:\n`;
  $("compose").hidden = false;
  $("detail").hidden = true;
  events?.close();
});
$("earlier").addEventListener("click", () => {
  if (!current?.cursor) return;
  const cursor = btoa(
    unescape(encodeURIComponent(JSON.stringify(current.cursor))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  void api<View>(
    `/api/jobs/${current.job.id}?cursor=${encodeURIComponent(cursor)}`,
  )
    .then((view) => {
      appendTranscript([...view.transcript].reverse(), true);
      current!.cursor = view.cursor;
      $("earlier").hidden = !view.cursor;
    })
    .catch(showError);
});
$("more-jobs").addEventListener("click", () => {
  void loadJobs(true).catch(showError);
});
$("logout").addEventListener("click", () => {
  void api("/api/logout", "POST", { requestId: crypto.randomUUID() })
    .then(showLogin)
    .catch(showError);
});
$("settings-open").addEventListener("click", () => {
  void api<typeof settings>("/api/settings")
    .then((value) => {
      settings = value;
      $<HTMLTextAreaElement>("common-instructions").value =
        value.commonInstructions;
      $("model-status").textContent = value.modelConfigured
        ? `モデル: ${value.model?.id ?? "設定済み"}`
        : "モデル未設定。管理者が VM 内の設定・秘密ファイルを登録してサービスを再起動してください。";
      $<HTMLDialogElement>("settings").showModal();
    })
    .catch(showError);
});
$("note-project").addEventListener("input", () => {
  $<HTMLTextAreaElement>("project-note").value =
    settings.projectNotes[$<HTMLInputElement>("note-project").value] ?? "";
});
$("settings-close").addEventListener("click", () =>
  $<HTMLDialogElement>("settings").close(),
);
$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const notes = { ...settings.projectNotes };
  const project = $<HTMLInputElement>("note-project").value;
  if (project) notes[project] = $<HTMLTextAreaElement>("project-note").value;
  void api("/api/settings", "PATCH", {
    requestId: crypto.randomUUID(),
    revision: settings.revision,
    commonInstructions: $<HTMLTextAreaElement>("common-instructions").value,
    projectNotes: notes,
  })
    .then(() => $<HTMLDialogElement>("settings").close())
    .catch(showError);
});
async function boot(): Promise<void> {
  const session = await api<{ csrf: string }>("/api/session");
  csrf = session.csrf;
  $("login").hidden = true;
  $("app").hidden = false;
  $("connection").textContent = "VM に接続中";
  await loadJobs();
}
void boot().catch((error) => {
  showLogin();
  if ((error as Error).message !== "ログインしてください")
    $("login-error").textContent = (error as Error).message;
});
export {};
