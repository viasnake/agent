import { randomUUID } from "node:crypto";
import { AgentError } from "../types.js";
import type { ProcessResult } from "../process.js";
import { runProcess } from "../process.js";
import type {
  EnvironmentCommand,
  EnvironmentDiagnosis,
  EnvironmentInfo,
  ExecutionEnvironment,
} from "./types.js";

export const FIRECRACKER_HELPER = "/usr/local/libexec/local-agent-firecracker";
const PROTOCOL_MAX_BYTES = 8 * 1024 * 1024;
const REQUEST_MAX_BYTES = 512 * 1024;
const MAX_COMMAND_ARGS = 128;
const MAX_ARG_BYTES = 16 * 1024;
const ADMIN_MAX_TIMEOUT_MS = 10 * 60 * 1000;
const ADMIN_MAX_OUTPUT_BYTES = 1024 * 1024;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Operation =
  "diagnose" | "create" | "start" | "status" | "execute" | "stop" | "destroy";

interface HelperRequest {
  op: Operation;
  id?: string;
  command?: {
    argv: string[];
    timeoutMs: number;
    maxOutputBytes: number;
  };
}

interface HelperFailure {
  code: string;
  message: string;
}

interface HelperResponse {
  ok: boolean;
  result?: unknown;
  error?: HelperFailure;
}

type HelperInvoker = (
  request: HelperRequest,
  signal: AbortSignal | undefined,
) => Promise<HelperResponse>;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new AgentError("FIRECRACKER_REQUEST", message);
}

function validId(id: string): string {
  if (typeof id !== "string" || !UUID_RE.test(id))
    invalid("Environment ID is not a UUID");
  return id;
}

function validateCommand(command: EnvironmentCommand): EnvironmentCommand {
  if (
    typeof command !== "object" ||
    command === null ||
    !Array.isArray(command.argv) ||
    command.argv.length === 0 ||
    command.argv.length > MAX_COMMAND_ARGS
  )
    invalid(`Command must contain 1-${MAX_COMMAND_ARGS} argv entries`);
  for (const arg of command.argv) {
    if (
      typeof arg !== "string" ||
      Buffer.byteLength(arg, "utf8") > MAX_ARG_BYTES ||
      arg.includes("\u0000")
    )
      invalid("Command arguments must be bounded strings");
  }
  if (!command.argv[0]) invalid("The first command argument must be non-empty");
  if (
    !Number.isSafeInteger(command.timeoutMs) ||
    command.timeoutMs < 1 ||
    command.timeoutMs > ADMIN_MAX_TIMEOUT_MS ||
    !Number.isSafeInteger(command.maxOutputBytes) ||
    command.maxOutputBytes < 1 ||
    command.maxOutputBytes > ADMIN_MAX_OUTPUT_BYTES
  )
    invalid("Command limits exceed the administrator bounds");
  return command;
}

function parseResponse(response: HelperResponse): HelperResponse {
  if (!isRecord(response) || typeof response.ok !== "boolean")
    throw new AgentError("FIRECRACKER_PROTOCOL", "Invalid helper response");
  if (response.ok) {
    if (Object.keys(response).sort().join(",") !== "ok,result")
      throw new AgentError("FIRECRACKER_PROTOCOL", "Invalid success response");
  } else {
    if (
      !isRecord(response.error) ||
      typeof response.error.code !== "string" ||
      typeof response.error.message !== "string" ||
      response.error.code.length > 128 ||
      response.error.message.length > 4096 ||
      Object.keys(response).sort().join(",") !== "error,ok" ||
      Object.keys(response.error).sort().join(",") !== "code,message"
    )
      throw new AgentError("FIRECRACKER_PROTOCOL", "Invalid failure response");
  }
  if (jsonBytes(response) > PROTOCOL_MAX_BYTES)
    throw new AgentError(
      "FIRECRACKER_PROTOCOL",
      "Helper response is too large",
    );
  return response;
}

async function invokeHelper(
  request: HelperRequest,
  signal?: AbortSignal,
): Promise<HelperResponse> {
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input, "utf8") > REQUEST_MAX_BYTES)
    invalid("Helper request is too large");
  let result: ProcessResult;
  try {
    result = await runProcess("sudo", ["-n", "--", FIRECRACKER_HELPER], {
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
      },
      input,
      signal,
      timeoutMs: ADMIN_MAX_TIMEOUT_MS + 5000,
      maxBytes: PROTOCOL_MAX_BYTES,
    });
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError(
      "FIRECRACKER_HELPER",
      `Could not invoke the privileged helper: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (result.truncated || !result.stdout.trim())
    throw new AgentError(
      "FIRECRACKER_PROTOCOL",
      "The helper response was incomplete",
    );
  let response: unknown;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new AgentError(
      "FIRECRACKER_PROTOCOL",
      "The helper returned invalid JSON",
    );
  }
  const parsed = parseResponse(response as HelperResponse);
  if (!parsed.ok) {
    throw new AgentError(
      parsed.error?.code ?? "FIRECRACKER_HELPER",
      parsed.error?.message ?? "The privileged helper failed",
    );
  }
  if (result.code !== 0 && parsed.ok)
    throw new AgentError(
      "FIRECRACKER_HELPER",
      "The privileged helper failed without a usable result",
    );
  return parsed;
}

function resultOf<T>(response: HelperResponse): T {
  if (!response.ok) {
    throw new AgentError(
      response.error?.code ?? "FIRECRACKER",
      response.error?.message ?? "Firecracker operation failed",
    );
  }
  return response.result as T;
}

function infoShape(value: unknown): EnvironmentInfo {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "backend,id,state,workspace" ||
    typeof value.id !== "string" ||
    !UUID_RE.test(value.id) ||
    value.backend !== "firecracker" ||
    !["stopped", "starting", "ready", "failed"].includes(String(value.state)) ||
    value.workspace !== "/workspace"
  )
    throw new AgentError(
      "FIRECRACKER_PROTOCOL",
      "Invalid environment information",
    );
  return value as unknown as EnvironmentInfo;
}

function diagnosisShape(value: unknown): EnvironmentDiagnosis {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "checks,ok" ||
    typeof value.ok !== "boolean" ||
    !Array.isArray(value.checks) ||
    value.checks.length > 32
  )
    throw new AgentError("FIRECRACKER_PROTOCOL", "Invalid diagnosis");
  const checks = value.checks.map(
    (check): { name: string; ok: boolean; detail: string } => {
      if (
        !isRecord(check) ||
        Object.keys(check).sort().join(",") !== "detail,name,ok" ||
        typeof check.name !== "string" ||
        check.name.length > 128 ||
        typeof check.ok !== "boolean" ||
        typeof check.detail !== "string" ||
        check.detail.length > 4096
      )
        throw new AgentError("FIRECRACKER_PROTOCOL", "Invalid diagnosis check");
      return {
        name: check.name,
        ok: check.ok,
        detail: check.detail,
      };
    },
  );
  return { ok: value.ok, checks };
}

function processShape(value: unknown, maxOutputBytes: number): ProcessResult {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "code,stderr,stdout,truncated" ||
    typeof value.code !== "number" ||
    !Number.isSafeInteger(value.code) ||
    value.code < -255 ||
    value.code > 255 ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    typeof value.truncated !== "boolean" ||
    Buffer.byteLength(value.stdout, "utf8") +
      Buffer.byteLength(value.stderr, "utf8") >
      maxOutputBytes
  )
    throw new AgentError("FIRECRACKER_PROTOCOL", "Invalid command result");
  return value as unknown as ProcessResult;
}

export class FirecrackerEnvironment implements ExecutionEnvironment {
  constructor(private readonly invoke: HelperInvoker = invokeHelper) {}

  async diagnose(signal?: AbortSignal): Promise<EnvironmentDiagnosis> {
    return diagnosisShape(
      resultOf(await this.invoke({ op: "diagnose" }, signal)),
    );
  }

  async create(signal?: AbortSignal): Promise<EnvironmentInfo> {
    const info = infoShape(
      resultOf(await this.invoke({ op: "create" }, signal)),
    );
    validId(info.id);
    return info;
  }

  async start(id: string, signal?: AbortSignal): Promise<EnvironmentInfo> {
    return infoShape(
      resultOf(await this.invoke({ op: "start", id: validId(id) }, signal)),
    );
  }

  async status(id: string, signal?: AbortSignal): Promise<EnvironmentInfo> {
    return infoShape(
      resultOf(await this.invoke({ op: "status", id: validId(id) }, signal)),
    );
  }

  async execute(
    id: string,
    command: EnvironmentCommand,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    const validated = validateCommand(command);
    return processShape(
      resultOf(
        await this.invoke(
          { op: "execute", id: validId(id), command: validated },
          signal,
        ),
      ),
      validated.maxOutputBytes,
    );
  }

  async stop(id: string, signal?: AbortSignal): Promise<EnvironmentInfo> {
    return infoShape(
      resultOf(await this.invoke({ op: "stop", id: validId(id) }, signal)),
    );
  }

  async destroy(id: string, signal?: AbortSignal): Promise<void> {
    const result = resultOf<unknown>(
      await this.invoke({ op: "destroy", id: validId(id) }, signal),
    );
    if (result !== null)
      throw new AgentError("FIRECRACKER_PROTOCOL", "Invalid destroy result");
  }
}

export function newEnvironmentId(): string {
  return randomUUID();
}
