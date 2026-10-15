import { z } from "zod";
import type { Config } from "./config.js";
import { Store } from "./storage.js";
import { AgentError, type Role, type Run } from "./types.js";
import {
  assertConnection,
  modelCandidates,
  selectModel,
  quotaScope,
} from "./policy.js";
import { endpointFetch } from "./network.js";

export class Router {
  constructor(
    readonly config: Config,
    readonly store: Store,
  ) {}
  async select(
    run: Run,
    role: Role,
    needsTools: boolean,
    signal: AbortSignal,
    requested?: string,
    exclude?: string | string[],
  ): Promise<string> {
    let selected = selectModel(
      this.config,
      run,
      role,
      needsTools,
      requested,
      exclude,
    );
    const candidates = modelCandidates(
      this.config,
      run,
      role,
      needsTools,
      exclude,
    );
    if (
      !requested &&
      !run.images?.length &&
      candidates.length > 1 &&
      this.config.routing.mode !== "rules"
    ) {
      try {
        const name = this.config.routing.classifier!,
          conn = this.config.connections[name]!;
        assertConnection(run, conn, name, this.config);
        const account = conn.accountEnv
          ? process.env[conn.accountEnv]
          : undefined;
        if (!account || !/^[a-f0-9]{32}$/i.test(account))
          throw new AgentError("AUTH", "Clef account ID is missing or invalid");
        const reservation = this.store.reserve(
          run,
          name,
          "@cf/cloudflare/clef-flash",
          conn.maxRequestUsd,
          this.config.limits.maxApiUsd,
          this.config.limits.maxRequests,
          conn.requestsPerMinute,
          quotaScope(conn),
        );
        const base = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run`;
        const response = await endpointFetch(
          base,
          AbortSignal.any([
            signal,
            AbortSignal.timeout(
              this.config.limits.requestTimeoutSeconds * 1000,
            ),
          ]),
        )(`${base}/@cf/cloudflare/clef-flash`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env[conn.secretEnv!]}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "clef-flash",
            state: { objective: run.objective, kind: run.kind, role },
            questions: {
              selection: {
                type: "choice",
                instructions:
                  "Select the most suitable configured role/capability profile for this task. Do not change permissions.",
                criteria: Object.fromEntries(
                  candidates.map((name, index) => [
                    `candidate_${index}`,
                    `${this.config.models[name]!.kinds.join(", ")}; ${this.config.models[name]!.roles.join(", ")}`,
                  ]),
                ),
              },
            },
          }),
        });
        if (!response.ok)
          throw new AgentError(
            "CLASSIFIER",
            `Clef returned HTTP ${response.status}`,
          );
        const body = (await response.json()) as { result?: unknown };
        const parsed = z
          .object({
            answers: z.object({
              selection: z.object({
                choice: z.string(),
                probabilities: z.record(z.string(), z.number().min(0).max(1)),
              }),
            }),
          })
          .parse(body.result);
        if (!/^candidate_\d+$/.test(parsed.answers.selection.choice))
          throw new AgentError(
            "CLASSIFIER",
            "Classifier returned an invalid candidate label",
          );
        const index = Number(
            parsed.answers.selection.choice.replace(/^candidate_/, ""),
          ),
          choice = candidates[index];
        if (!choice)
          throw new AgentError(
            "CLASSIFIER",
            "Classifier returned an unknown candidate",
          );
        this.store.settle(run, reservation, {
          input: null,
          output: null,
          costUsd: null,
        });
        this.store.event(run.id, "classifier_result", {
          mode: this.config.routing.mode,
          rule: selected,
          choice,
          probabilities: parsed.answers.selection.probabilities,
        });
        if (this.config.routing.mode === "assisted") selected = choice;
      } catch (error) {
        signal.throwIfAborted();
        this.store.event(run.id, "classifier_unavailable", {
          reason: error instanceof AgentError ? error.code : "CLASSIFIER",
          fallback: "rules",
        });
      }
    }
    this.store.event(run.id, "model_selected", {
      model: selected,
      role,
      connection: this.config.models[selected]!.connection,
      reason: requested ? "explicit" : "eligible profile priority",
    });
    return selected;
  }
}
