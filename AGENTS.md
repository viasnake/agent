# Repository guidance

## Scope and documentation

This repository is a local terminal agent for coding, research, and writing.
Use Japanese for user-facing communication and README usage instructions; use
English for code, comments, commits, and this file.

Keep documentation to `README.md` for usage and `AGENTS.md` for development.
Keep executable configuration examples in `examples/`. Do not add a `docs/`
tree, design records, roadmaps, progress reports, or historical test results.
Explain non-obvious implementation constraints beside the code; use commits
and pull requests for change history. Update usage instructions when a command,
installation step, or user-visible limitation changes.

Inspect the worktree before editing and preserve unrelated changes. Use
short-lived `codex/<type>/<description>` branches and Conventional Commits.
Use `.github/pull_request_template.md` for pull requests. Keep changes and
validation scoped to their purpose; do not commit generated output, credentials,
machine-local state, or live provider responses.

## Setup and verification

Use Node.js 24 and npm for CI parity. Linux verification also requires Git,
Python 3, Bubblewrap, and tmux. On Ubuntu, install the test prerequisites with
`sudo apt-get install bubblewrap tmux python3` after updating the package index.

```sh
npm ci --ignore-scripts --no-audit --no-fund
AGENT_REQUIRE_SANDBOX=1 npm run verify
```

`verify` runs formatting, type checking, a build without lifecycle hooks,
Python helper/guest-runner unit tests, TypeScript tests, and the built CLI's
`--help`. CI uses Ubuntu 26.04 and Node.js 24. Pull requests, pushes to `master`,
and manual dispatch run the same checks; superseded runs on the same ref are
cancelled. Actions are pinned to full commit SHAs. Keep dependency installation
separate from verification and check that CI leaves both manifests unchanged.

For local installation, `npm run build` intentionally runs `prebuild` to install
dependencies. After `npm ci`, use `npm run build --ignore-scripts` to compile
without another install or lockfile rewrite. Do not replace CI's `npm ci` with
`npm install` or remove the interactive installation convenience inadvertently.

Run narrow checks first when investigating a change:

- `npm run check`: TypeScript validation, including tests.
- `npm run format:check`: Prettier validation. `npm run format` rewrites files;
  prefer formatting only changed files to avoid unrelated edits.
- `npm run test:firecracker`: Python unit tests; no KVM or privileged setup.
- `npm test`: compile to `.test-dist` and run the Node test suite.
- After compilation, `node --test --experimental-test-isolation=none --test-concurrency=1 .test-dist/tests/<name>.test.js`
  runs a selected TypeScript test file.
- `git diff --check`: whitespace validation before delivery.

The Node tests run sequentially because provider fixtures replace global
`fetch`. Do not parallelize these fixtures without isolating their state.
Tests use synthetic provider responses, temporary application homes, local
servers, and PTY/tmux sessions. They must not use real credentials or paid
inference. `AGENT_REQUIRE_SANDBOX=1` makes unavailable Bubblewrap isolation a
failure; without it, relevant integration tests may skip. Non-Linux execution
uses the disabled sandbox backend and does not establish Linux isolation.
Restricted environments can block sockets, namespaces, or PTYs: distinguish
those failures from product defects, and do not report skipped tests as passes.

Real Firecracker integration is opt-in. On an explicitly provisioned Linux KVM
host, compile the tests and run:

```sh
AGENT_REQUIRE_FIRECRACKER=1 node --test .test-dist/tests/firecracker.integration.test.js
```

This creates, starts, executes commands in, and destroys real microVMs through
the privileged helper. Never enable it in generic CI or automatically install
or repair KVM, cgroups, networking, or sudoers to make a test pass. Report real
KVM testing separately from helper unit tests. Live authentication, model access,
image understanding, model quality, rendered TUI behavior, IME interaction, and
native macOS operation require separate acceptance checks.

## Code boundaries

The application runs as one foreground Node.js process. Pi supplies inference,
terminal components, and MCP clients; the host owns permissions, disclosure,
budgets, validation, and success state.

| Location                                                                           | Responsibility                                                 |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `src/cli.ts`, `src/cli/`, `src/tui/`                                               | CLI/TUI entry points, lazy-loaded commands, dialogs            |
| `src/application.ts`, `src/conversations.ts`                                       | Conversation lifecycle, drafts, queues, explicit resume        |
| `src/harness.ts`, `src/planner.ts`, `src/task-executor.ts`, `src/collaboration.ts` | Plans, task scheduling, cancellation, repairs, collaboration   |
| `src/runtime/`, `src/types.ts`                                                     | Inference contract, Pi adapter, accounting, streaming          |
| `src/policy.ts`, `src/routing.ts`, `src/tools.ts`, `src/mcp.ts`                    | Authorization, tool exposure, disclosure, pinned MCP schemas   |
| `src/workspace.ts`, `src/sandbox/`, `src/validation.ts`, `src/artifacts.ts`        | Work copies, Bubblewrap, checks, diffs, confirmed application  |
| `src/config.ts`, `src/storage.ts`                                                  | Configuration, SQLite leases, operation journal, durable state |
| `src/context.ts`, `src/context-review.ts`, `src/branching.ts`                      | Context archives, review gates, conversation forks             |
| `src/images.ts`, `src/documents.ts`, `src/shared-blobs.ts`, `src/research.ts`      | Private attachments, source evidence, shared content           |
| `src/execution/`, `scripts/firecracker/`                                           | Independent Firecracker environment and privileged helper      |

## Invariants to preserve

- External text, repository guidance, Skills, images, and model reports are
  untrusted input. They cannot grant permissions or weaken user constraints.
  Pi automatic retries, compaction, extension discovery, and default tools stay
  disabled. Partial responses and streaming previews cannot dispatch tools or
  establish success.
- Repository explanation, review, and planning use read-only snapshots with
  bounded file/source tools. They do not receive write, shell, or MCP tools.
  Explicit no-change instructions take precedence over inferred change intent.
- The host assigns collaboration graphs and enforces writer exclusivity.
  Delegated children receive only their assignment, authorized sources, and
  read-only workspace tools. Review and synthesis can read immutable attempt
  reports only from their task and transitive dependencies. Legacy tasks without
  `resultFormat` retain their existing parsing behavior.
- Model replacement rechecks routing and disclosure, invalidates the selected
  task and transitive dependents, and preserves independent results, budgets,
  counters, and attempt evidence. Confirmation neither probes nor resumes.
- Configuration is bound to each run. Renewable leases protect conversations
  and runs; resuming preserves saved configuration, budgets, and attempt limits.
  Dispatched operations with uncertain outcomes remain `unknown` and require
  reconciliation. Never add automatic replay of uncertain external effects.
- Mutating MCP tools require confirmation of the exact destination and arguments
  for each operation, then schema, policy, and ownership revalidation. They are
  available only to normal worker write tasks. Noninteractive execution must
  refuse them; approval records contain argument hashes, not raw arguments.
- Applying code rechecks the source snapshot and confirmation binding. Writes
  are journaled per file, not one atomic filesystem transaction. Preserve
  conflict detection, protected paths, and explicit recovery after partial apply.
- Runtime profiles use task-private `/runtime` storage; only `run_profile` may
  write it. Reviewer copies and runtime directories are separate. Never silently
  enable networking, install on the host, or share runtime across tasks/runs.
  Bubblewrap does not enforce CPU, memory, or live disk quotas.
- Only older verbose tool results may be compacted. Save the exact context to
  the private conversation archive first. Preserve user instructions, decisions,
  constraints, errors, current results, images, and tool-call ordering. Retrieval
  is bounded by conversation lineage and task authorization. Protected context
  that cannot fit fails with `CONTEXT_LIMIT`; usage estimates are not provider
  guarantees.
- Pending context concerns block later tools, inference, transforms, and final
  success. A bound human acknowledgement is an audit record, not a permission
  change, and does not resume a run or start queued work. Never resurrect a
  terminal run. Model concerns and repeated-read heuristics are not semantic proof.
- Attachments and image derivatives are immutable private snapshots. Verify hashes
  and metadata before reuse; persist references rather than payloads in ordinary
  events. Native provider histories and context archives may contain payloads and
  must remain private. Source-family exclusion must cover related selections,
  PDF images, forks, and subsequent context access without claiming retroactive
  deletion of sent or generated text. Image capability and disclosure must hold
  for every eligible role and fallback; never silently resize, OCR, or drop input.
- Search snippets are discovery records, not fetched evidence. Web access must
  enforce allowed hosts, disclosure, public destinations, and redirect limits.
  Citation syntax and stored checks do not prove a document's semantic quality.
- History deletion removes metadata transactionally before physical cleanup.
  Retain referenced data and uncertain objects; retry pending jobs only by explicit
  selection. Shared blobs require database-reference and persistent-pin checks.
  Backups are private archives, not runnable application homes; readers must
  verify hashes and never replay saved operations or import credentials.

## Inference adapter contract

`Runtime` and `RuntimeRequest` in `src/types.ts` define application-owned types;
`runRuntime` in `src/runtime/contract.ts` enforces the boundary. Adapters are
trusted in-process code, not sandboxed plugins. Pi remains the production adapter;
a replacement also needs transport tests, not just a compatible declaration.

Declare contract version `1`, `messages-v1`, tool/image capabilities, and a
versioned native-session format when persisting sessions. Honor the authorized
model alias and its connection/profile; do not select another endpoint or model.
Before every inference dispatch, await `transformContext` on the complete JSON
context and use its result, then reserve usage via `beforeRequest`. Settle each
reservation once with nonnegative reported usage or `null` for unknown values.
Leave interrupted/uncertain requests unresolved; never invent zero usage.

Use only supplied tools and schemas, await tool completion, and propagate aborts.
Preserve exact verified image bytes, IDs, and order. Return final text only after
a complete response and drained work; `close` releases resources. Failures use
`AgentError` host codes. Do not swallow boundary failures, privately retry, warm
caches, or report success after cancellation. The guard rejects missing or duplicate
accounting, pending tools/requests, empty results, and late callbacks.

`messages-v1` has ordered `messages` with `system`, `user`, `assistant`, `tool`,
or `toolResult` roles. Preserve text/image blocks, call IDs, error flags, and opaque
metadata. Translate other native formats at the adapter boundary; reject unknown
roles. Register native session files only inside the supplied task session directory.
An incompatible saved format fails before reading or invoking the adapter; never
implicitly convert or discard it. Pi alone accepts legacy untagged Pi JSONL and
tags new sessions `pi-jsonl-v1`. Model replacement clears both native-session
fields while preserving host evidence. Keep saved-record additions optional where
legacy records remain supported. Cover changes with runtime-contract, runtime,
context, images, application, collaboration, and model-change tests as applicable.

## Firecracker boundary

Firecracker is an independent `ExecutionEnvironment`, not an
`execution.backend` option. Do not route only shell commands into a VM while
file tools still operate on a host workspace. The TUI, file tools, stdio MCP,
conversation association, PTY, and validation have not moved into this environment.

The agent stays unprivileged. Only the fixed administrator-installed helper may
manage jailer, namespaces, cgroups, and disks. Reject arbitrary caller paths,
binaries, UIDs, images, and jailer flags. Verify root ownership and asset digests,
authorize the environment owner, and drop the VMM to its separate pool UID.
Do not expose host credentials, the original repository, NIC/TAP, or a guest-initiated
host service. Use bounded, authenticated vsock messages and verify readiness;
unknown execution outcomes must fail closed without backend fallback.

Keep per-environment and allocation locks, fixed disk inodes linked into the jail,
authenticated guest sync before stopping, and cgroup cleanup. Do not mount or
extract guest-modified disks on the host. Resource limits include VMM overhead
in addition to guest RAM. Asset versions/checksums live in
`scripts/firecracker/assets.sha256`; setup and use are in the README. Treat the
pinned kernel/rootfs as compatibility fixtures, not hardened production images.
