import { dirname, isAbsolute, resolve } from "node:path";
import { AgentError, type Runtime, type RuntimeRequest } from "../types.js";

function failure(message: string): never {
  throw new AgentError("RUNTIME_CONTRACT", message);
}

function contextFrame(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    failure("Runtime context must be a messages-v1 object");
  const messages = (value as Record<string, unknown>).messages;
  if (
    !Array.isArray(messages) ||
    messages.some(
      (message) =>
        !message ||
        typeof message !== "object" ||
        !["system", "user", "assistant", "tool", "toolResult"].includes(
          message.role,
        ),
    )
  )
    failure("Runtime context must preserve ordered message roles");
}

export async function runRuntime(
  runtime: Runtime,
  request: RuntimeRequest,
  sessionFormat?: string,
): Promise<string> {
  request.signal.throwIfAborted();
  const contract = { ...runtime.contract };
  if (
    contract.version !== 1 ||
    contract.context !== "messages-v1" ||
    typeof contract.tools !== "boolean" ||
    typeof contract.images !== "boolean" ||
    (contract.sessionFormat !== undefined &&
      (typeof contract.sessionFormat !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(contract.sessionFormat))) ||
    (contract.acceptsLegacySessions !== undefined &&
      typeof contract.acceptsLegacySessions !== "boolean") ||
    (contract.acceptsLegacySessions && !contract.sessionFormat) ||
    (request.tools.length && !contract.tools) ||
    (request.images?.length && !contract.images)
  )
    failure("Runtime version or capabilities do not support this request");
  if (
    request.sessionFile &&
    (!contract.sessionFormat ||
      (sessionFormat === undefined
        ? !contract.acceptsLegacySessions
        : sessionFormat !== contract.sessionFormat))
  )
    throw new AgentError(
      "RUNTIME_SESSION",
      "Saved native session format does not match this runtime. Start a new request after /compact, or use the original adapter; no session was converted or discarded.",
    );
  let active = true,
    requests = 0,
    toolsRunning = 0,
    boundaryFailure: unknown;
  const invocation = new AbortController();
  const signal = AbortSignal.any([request.signal, invocation.signal]);
  const pending = new Set<string>();
  const seen = new Set<string>();
  const current = () => {
    if (!active) failure("Runtime callbacks cannot outlive the invocation");
    if (boundaryFailure) throw boundaryFailure;
    signal.throwIfAborted();
  };
  const boundary = <T>(action: () => T): T => {
    try {
      current();
      return action();
    } catch (error) {
      boundaryFailure ??= error;
      throw error;
    }
  };
  try {
    const result = await runtime.run({
      ...request,
      signal,
      tools: request.tools.map((tool) => ({
        ...tool,
        execute: async (args, toolSignal) => {
          boundary(() => {
            if (!requests) failure("Tools require an accounted model request");
          });
          toolsRunning++;
          try {
            return await tool.execute(
              args,
              AbortSignal.any([toolSignal, signal]),
            );
          } finally {
            toolsRunning--;
          }
        },
      })),
      transformContext: async (context, signal) => {
        try {
          current();
          signal.throwIfAborted();
          contextFrame(context);
          const transformed = request.transformContext
            ? await request.transformContext(
                context,
                AbortSignal.any([signal, request.signal]),
              )
            : context;
          current();
          signal.throwIfAborted();
          contextFrame(transformed);
          return transformed;
        } catch (error) {
          boundaryFailure ??= error;
          throw error;
        }
      },
      onSession: (file) =>
        boundary(() => {
          if (
            !contract.sessionFormat ||
            !isAbsolute(file) ||
            dirname(resolve(file)) !== resolve(request.sessionDir)
          )
            failure(
              "Native session files must belong to this task's session directory",
            );
          request.onSession(file, contract.sessionFormat);
        }),
      beforeRequest: (bytes, images = 0, imageTokens = 0) =>
        boundary(() => {
          if (
            [bytes, images, imageTokens].some(
              (value) => !Number.isSafeInteger(value) || value < 0,
            )
          )
            failure("Request estimates must be nonnegative safe integers");
          const id = request.beforeRequest(bytes, images, imageTokens);
          if (!id || seen.has(id))
            failure("Each request needs a unique reservation");
          seen.add(id);
          pending.add(id);
          requests++;
          return id;
        }),
      afterRequest: (id, usage) => {
        // Accounting for an already sent request remains valid during cancellation.
        try {
          if (!active || !pending.has(id))
            failure("Unknown or repeated request settlement");
          if (
            [usage.input, usage.output].some(
              (value) =>
                value !== null && (!Number.isSafeInteger(value) || value < 0),
            ) ||
            (usage.costUsd !== null &&
              (!Number.isFinite(usage.costUsd) || usage.costUsd < 0))
          )
            failure("Usage must be nonnegative or explicitly unknown");
          request.afterRequest(id, usage);
          pending.delete(id);
        } catch (error) {
          boundaryFailure ??= error;
          throw error;
        }
      },
      onEvent: (type, detail) => {
        if (active) request.onEvent(type, detail);
      },
    });
    current();
    if (boundaryFailure) throw boundaryFailure;
    if (!requests || pending.size || toolsRunning)
      failure("A final result requires accounted requests and completed tools");
    if (typeof result !== "string" || !result.trim())
      throw new AgentError(
        "EMPTY_RESULT",
        "Runtime returned no complete final result",
      );
    return result;
  } finally {
    active = false;
    invocation.abort();
  }
}
