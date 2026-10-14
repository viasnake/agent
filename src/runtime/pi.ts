import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { join, dirname } from "node:path";
import { Type } from "typebox";
import type { Config, Paths } from "../config.js";
import { AgentError, type Runtime, type RuntimeRequest } from "../types.js";
import { privateDirectory } from "../util.js";
import { connectionRuntime, providerId } from "./providers.js";
import { guardModelStream } from "./transport.js";
export function isolatedLoader(system: string): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => system,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
export class PiRuntime implements Runtime {
  constructor(
    readonly config: Config,
    readonly paths: Paths,
  ) {}
  async run(request: RuntimeRequest): Promise<string> {
    request.signal.throwIfAborted();
    const selected = this.config.models[request.model];
    if (!selected)
      throw new AgentError("NO_MODEL", `Unknown model ${request.model}`);
    const conn = this.config.connections[selected.connection]!;
    const runtime = await connectionRuntime(
      this.config,
      this.paths,
      selected.connection,
    );
    if (
      conn.type === "chatgpt" &&
      !(await runtime.listCredentials()).some(
        (c) => c.providerId === "openai" && c.type === "oauth",
      )
    )
      throw new AgentError(
        "AUTH",
        `Run agent auth login ${selected.connection}; API key fallback is disabled`,
      );
    const found = runtime.getModel(providerId(conn), selected.id);
    if (!found)
      throw new AgentError(
        "NO_MODEL",
        `SDK does not know ${selected.id}; run agent models list --connection ${selected.connection}`,
      );
    const model = {
      ...found,
      maxTokens: Math.min(found.maxTokens, selected.maxOutputTokens),
    };
    const checkFailure = guardModelStream(
      runtime,
      model,
      conn,
      request,
      this.config.limits.requestTimeoutSeconds,
    );
    await privateDirectory(request.sessionDir);
    const manager = request.sessionFile
      ? dirname(request.sessionFile) === request.sessionDir
        ? SessionManager.open(
            request.sessionFile,
            request.sessionDir,
            request.sessionDir,
          )
        : SessionManager.forkFrom(
            request.sessionFile,
            request.sessionDir,
            request.sessionDir,
          )
      : SessionManager.create(request.sessionDir, request.sessionDir);
    const sessionPath = manager.getSessionFile();
    if (sessionPath) request.onSession(sessionPath);
    const { session } = await createAgentSession({
      cwd: request.sessionDir,
      agentDir: join(this.paths.auth, selected.connection),
      modelRuntime: runtime,
      model,
      thinkingLevel: "off",
      sessionManager: manager,
      resourceLoader: isolatedLoader(request.system),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false, provider: { maxRetries: 0 } },
        cacheWarming: "off",
        defaultTools: [],
      }),
      tools: request.tools.map((t) => t.name),
      customTools: request.tools.map((tool) => ({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: Type.Unsafe(tool.parameters),
        execute: async (_id, params, signal) => ({
          content: [
            {
              type: "text",
              text: await tool.execute(
                params as Record<string, unknown>,
                AbortSignal.any([request.signal, ...(signal ? [signal] : [])]),
              ),
            },
          ],
          details: {},
        }),
      })),
    });
    const abort = () => {
      void session.abort();
    };
    request.signal.addEventListener("abort", abort, { once: true });
    session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      )
        request.onEvent("text_delta", {
          text: event.assistantMessageEvent.delta,
        });
      if (event.type === "tool_execution_start")
        request.onEvent("tool_started", {
          name: event.toolName,
          toolId: event.toolCallId,
          args: event.args,
        });
      if (event.type === "tool_execution_update")
        request.onEvent("tool_progress", {
          name: event.toolName,
          toolId: event.toolCallId,
        });
      if (event.type === "tool_execution_end")
        request.onEvent("tool_finished", {
          name: event.toolName,
          toolId: event.toolCallId,
          failed: event.isError,
          cancelled: request.signal.aborted,
        });
    });
    try {
      await session.prompt(request.objective, { expandPromptTemplates: false });
      await session.waitForIdle();
      request.signal.throwIfAborted();
      checkFailure();
      const text = session.getLastAssistantText();
      if (!text?.trim())
        throw new AgentError("EMPTY_RESULT", "Model returned no final result");
      return text;
    } finally {
      request.signal.removeEventListener("abort", abort);
      session.dispose();
    }
  }
  async close(): Promise<void> {}
}
