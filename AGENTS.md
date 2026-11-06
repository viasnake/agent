# Repository guidance

## Product and scope

This is a single-user personal work agent inside a manually started Ubuntu VM.
The host has QEMU init/start scripts and a browser. The guest runs a single
TypeScript HTTP service using Pi Durable 1.5.0 and SQLite; all arbitrary work
runs under a separate Unix UID. One job runs at a time, including decision waits.

Do not add a host daemon, VM manager, automatic host startup, Proxmox,
Firecracker, distributed workers, a generic harness, DAG engine, or plugin system.
Legacy TUI, CLI, runtime and saved-session formats have no compatibility promise.
Do not erase old user data, VM disks, secrets or Git history.

Use Japanese for user-facing text and README instructions. Use English for code,
comments, commits and this file. Keep maintained prose in README.md and AGENTS.md;
put executable examples in examples/. Do not add a docs tree, design records,
roadmaps, progress reports, historical test results or copies of handoff documents.
Explain current non-obvious constraints beside their implementation.

## Work and delivery

Inspect the worktree before editing and preserve unrelated changes. Avoid
concurrent edits to the same files. Use short-lived codex/type/description
branches and Conventional Commits. Follow .github/pull_request_template.md.
Do not push directly to master, rewrite shared history, merge or publish a
release without explicit authorization. Do not commit generated output, live
provider responses, credential files, machine state or dependency trees.

## Setup and checks

Use Node.js 26.13.0, npm and the committed lockfile. Install separately from builds:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install chromium
npm run verify
```

Linux tests need Git, Python 3, Poppler, Japanese fonts and Chromium system
libraries. See README for preparation. Build has no dependency-install hook.
`verify` runs formatting, type checking, build, nonprivileged unit/integration
checks, actual HTTP/browser E2E, and entry-point help. Tests compile into
.test-dist and evidence is generated in ignored test-results/.

Use `npm run check`, a selected compiled Node test, or `git diff --check` for
narrow changes. Keep tests tied to concrete failures. Ordinary tests use a faux
provider and local external-service fixtures, but real Pi Durable, SQLite,
files, processes, HTTP and Chromium. TestRunner is test-only dependency injection;
never expose it as a production mode or fallback. Production Chromium enables
its sandbox; ordinary browser fixtures do not establish that guest boundary.

`npm run test:guest` requires AGENT_GUEST_TEST=1, administrator privileges and a
dedicated provisioned guest with agent.service explicitly stopped. It must not
install/repair system prerequisites or interrupt user jobs. `npm run test:live`
requires explicit opt-in, a selected input, private credential file and approved
paid-model disclosure. Neither belongs in default CI. Missing prerequisites are
blocked (exit 77), not pass. WHPX, KVM, guest security, rendered quality and live
model quality are separate acceptance claims.

## Code boundaries

- src/service.ts and src/state.ts: Pi Document job state, admission, budgets,
  recovery, validation and final success.
- src/tools.ts and src/provider.ts: public Pi extensions and the dispatch gate.
- src/execution/: bounded local protocol; worker files, shell, browser and PDF.
- src/integrations/github.ts: credentialed fixed-target GitHub API operations.
- src/artifacts.ts: immutable control-owned artifact copies and verified reads.
- src/server.ts and web/: authentication, typed HTTP projections, SSE and UI.
- vm/: manual host scripts, initial disk setup, fixed UID launcher and guest units.

Inspect installed SDK exports and declarations before changing the adapter.
Pi IDs are branded numbers; Documents require strict JSON and transaction drafts
cannot escape a commit. Admit submissions with the job change in one commit, or
retain the durable admission record until its idempotent submit is placed.
Do not directly edit SDK tables or monkey-patch its internals.

## Invariants

Repository files, websites, packages and model output are untrusted inputs, never
permission grants. Only the user can change limits, approve disclosure or grant
external writes. Credentials never enter the worker environment, prompts, SSE,
logs or artifacts. No project code, Git config, hook or credential helper runs
as agent-control. GitHub writes use the API and a dedicated new branch only.

All file, shell, browser, dependency and PDF actions use the same work boundary.
The fixed sudo launcher, Node and installation tree must be root-owned; sudoers
permits only agent-work, no arguments and no SETENV. Rebuild the environment
from an allowlist. NoNewPrivileges is applied after the UID switch, not to the
control unit in a way that breaks sudo. Keep guest UID, nftables, AppArmor,
Chromium sandbox and systemd cleanup checks aligned. A directory or NAT is not
an execution sandbox. Never silently fall back when the mount, UUID, UID,
firewall, browser sandbox or storage is unavailable.

Pi owns its tasks and conversations; AppDoc owns job policy, grants, remaining
limits, accepted inputs, operations and artifact metadata. Do not introduce a
second job DB or independent workflow engine. The supported main entry point
acquires flock before opening SQLite. A storage failure seals admission; stop
and reopen instead of continuing with a failed Harness.

Generation hook errors may be skipped by Pi. Model dispatch is enforced at the
provider boundary and counts retries/compaction before sending. Keep the saved
provider session and selected model bound to the active job. Do not reset
budgets, repair counts or absolute deadlines on restart/resume.

Browser disconnects never cancel a job. Pause is admission stop plus abort and
cleanup, not an OS stack snapshot. Shutdown preserves unfinished jobs. Unknown
shell or external outcomes block replacement work until reconciled. Never mark
generic shells replay-safe; a fresh tool ID or old approval cannot bypass the
unknown-operation gate. A crash with external permission also requires review.

Bind approvals to job, target, argument hash and policy revision. Commit prepared
and dispatched intent before the effect; persist the external result afterward.
An external success followed by a lost response remains unknown. Reconciliation
queries existing results; it never resends the mutation. Backup restoration must
start with an explicit recovery hold; do not claim automatic restore detection or
power-loss exactly-once from SQLite WAL/NORMAL.

Success requires current immutable artifacts, current command/PDF validation,
self-review, all required raster pages delivered for inspection, no unprocessed
input and no unknown operation. Check the exact current job revision in the
final commit so a late pause/cancel/input cannot be overwritten by success.
Machine checks, model self-review and human quality acceptance remain distinct.
