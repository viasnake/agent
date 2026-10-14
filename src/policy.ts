import type { Config, Connection } from "./config.js";
import { AgentError, type DataClass, type Role, type Run } from "./types.js";
import { Store } from "./storage.js";

export function assertDisclosure(
  run: Pick<Run, "localOnly" | "dataClass">,
  target: { local: boolean; allowedData: DataClass[] },
  label: string,
): void {
  if ((run.localOnly || run.dataClass === "restricted") && !target.local)
    throw new AgentError("DISCLOSURE_DENIED", `${label} is not local`);
  if (!target.allowedData.includes(run.dataClass))
    throw new AgentError(
      "DISCLOSURE_DENIED",
      `${label} does not allow ${run.dataClass} data`,
    );
}
export function assertConnection(
  run: Run,
  connection: Connection,
  label: string,
  config: Config,
): void {
  if (!connection.enabled)
    throw new AgentError(
      "CONNECTION_DISABLED",
      `Connection ${label} is disabled`,
    );
  assertDisclosure(
    run,
    { local: connection.type === "local", allowedData: connection.allowedData },
    label,
  );
  if (
    connection.billing === "api" &&
    (config.limits.maxApiUsd === 0 || connection.maxRequestUsd === 0)
  )
    throw new AgentError(
      "BUDGET",
      `${label} requires a positive run budget and request reservation`,
    );
  if (
    connection.type !== "local" &&
    connection.type !== "chatgpt" &&
    (!connection.secretEnv || !process.env[connection.secretEnv])
  )
    throw new AgentError(
      "AUTH",
      `${label}: set ${connection.secretEnv ?? "secretEnv in configuration"}`,
    );
}
export const quotaScope = (connection: Connection) =>
  `${connection.type}:${connection.account}`;
export function modelCandidates(
  config: Config,
  run: Run,
  role: Role,
  needsTools: boolean,
  exclude?: string | string[],
): string[] {
  const excludedNames =
    typeof exclude === "string" ? [exclude] : (exclude ?? []);
  return Object.entries(config.models)
    .filter(([name, model]) => {
      if (
        excludedNames.includes(name) ||
        !model.roles.includes(role) ||
        (run.kind !== "chat" && !model.kinds.includes(run.kind)) ||
        (needsTools && !model.tools)
      )
        return false;
      if (excludedNames.some((alias) => config.models[alias]?.id === model.id))
        return false;
      try {
        assertConnection(
          run,
          config.connections[model.connection]!,
          model.connection,
          config,
        );
        return true;
      } catch {
        return false;
      }
    })
    .sort(([a, am], [b, bm]) => bm.priority - am.priority || a.localeCompare(b))
    .map(([key]) => key);
}
export function selectModel(
  config: Config,
  run: Run,
  role: Role,
  needsTools: boolean,
  requested?: string,
  exclude?: string | string[],
): string {
  const candidates = modelCandidates(config, run, role, needsTools, exclude);
  if (requested && !candidates.includes(requested))
    throw new AgentError(
      "NO_MODEL",
      `Requested model ${requested} is unavailable or disallowed for ${role}; check capabilities, credentials, privacy, and budget`,
    );
  const selected = requested ?? candidates[0];
  if (!selected)
    throw new AgentError(
      "NO_MODEL",
      `No authorized ${role} model is available for ${run.kind}/${run.dataClass}${run.localOnly ? "/local-only" : ""}`,
    );
  return selected;
}
export function reserveModel(
  config: Config,
  store: Store,
  run: Run,
  modelName: string,
  inputBytes: number,
): string {
  if (store.operations(run.id).some((o) => o.status === "unknown"))
    throw new AgentError(
      "UNKNOWN_OPERATION",
      "An operation needs reconciliation before another model request",
    );
  const model = config.models[modelName];
  if (!model) throw new AgentError("NO_MODEL", "Model is not configured");
  const conn = config.connections[model.connection]!;
  assertConnection(run, conn, model.connection, config);
  if (inputBytes > config.limits.maxInputBytes)
    throw new AgentError(
      "CONTEXT_LIMIT",
      "Input exceeds the configured limit; narrow the task or supply a smaller input",
    );
  // A byte bound is deliberately conservative. No context is silently discarded.
  if (inputBytes > model.contextWindow * 3)
    throw new AgentError(
      "CONTEXT_LIMIT",
      "Input may exceed the model context window; start a narrower task",
    );
  return store.reserve(
    run,
    model.connection,
    model.id,
    conn.billing === "api" ? conn.maxRequestUsd : 0,
    config.limits.maxApiUsd,
    config.limits.maxRequests,
    conn.requestsPerMinute,
    quotaScope(conn),
  );
}
