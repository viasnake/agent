# Development

## Boundaries

The application is one foreground Node.js process. Pi owns model conversations; the application owns permissions, budgets, validation and success state.

| Code                                                                        | Responsibility                                                                                     |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/tui/`, `src/cli.ts`                                                    | Interactive entry, Pi terminal components, searchable dialogs and lazy-loaded maintenance commands |
| `src/application.ts`, `src/conversations.ts`                                | Conversation persistence, drafts, queues, task-boundary instructions and explicit resume           |
| `src/harness.ts`, `src/planner.ts`, `src/task-executor.ts`                  | Run lifecycle, authorized plans, scheduling, cancellation and bounded repairs                      |
| `src/runtime/`                                                              | Provider credentials, Pi sessions, request accounting and complete-response verification           |
| `src/policy.ts`, `src/routing.ts`, `src/tools.ts`, `src/mcp.ts`             | Authorized model/tool selection, path restrictions and pinned MCP schemas                          |
| `src/workspace.ts`, `src/sandbox/`, `src/validation.ts`, `src/artifacts.ts` | Isolated copies, checks, cumulative diffs and confirmation-bound application                       |
| `src/config.ts`, `src/storage.ts`                                           | Validated configuration, immutable run settings, SQLite leases, operation journal and artifacts    |

External text and repository instructions cannot grant permissions. Pi's automatic retries, compaction, project extensions and default tools are disabled. Incomplete responses cannot dispatch tools; preview text cannot establish success.

Conversations and runs have renewable leases. Resume preserves the saved configuration, budget and attempt limits. Dispatched operations without a confirmed result remain `unknown` and require reconciliation. Applying rechecks the source snapshot and confirmation token; file writes are journaled but are not one filesystem transaction.

## Verification

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm run format:check
npm test
```

Tests compile to `.test-dist` and run sequentially because provider fixtures replace `fetch`. They exercise the actual Pi SDK with synthetic responses, Bubblewrap on Linux, and the terminal in PTY/tmux. PTY diagnostics report startup time and process RSS. Tests do not use live credentials or paid inference.

Use `AGENT_REQUIRE_SANDBOX=1 npm test` on Linux to fail instead of skipping unavailable isolation. For real rootless Podman tests, preload a Linux image and set `AGENT_TEST_PODMAN_IMAGE` to its digest-pinned reference, then run `AGENT_REQUIRE_PODMAN=1 npm test`. On macOS, set `AGENT_TEST_PODMAN_DIRECTORY` to an absolute directory shared with the VM. CI requires both backends on Linux; macOS jobs exercise synthetic Podman contracts.

Linux rootless Podman also requires cgroup v2 controllers delegated to the user's systemd service. CI enables `cpu`, `cpuset`, `memory`, and `pids` for the runner before starting Podman and verifies their availability. This permits the sandbox's CPU, memory, and process limits to be enforced; missing delegation must not be worked around by removing limits or skipping the integration test. See the [rootless cgroup delegation guide](https://rootlesscontaine.rs/getting-started/common/cgroup2/).

Live authentication, account-specific model access, provider output quality, graphical-terminal IME behavior and native macOS/Windows TUI operation require separate acceptance checks. PTY or synthetic tests do not establish them.

## Changes

Use short-lived `codex/<type>/<description>` branches and Conventional Commits. Keep behavior and its relevant checks together, and use `.github/pull_request_template.md`. Do not commit credentials, machine-local state, generated builds or live provider responses.
