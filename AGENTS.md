# Repository guidance

## Product and scope

This is a single-user, web-accessible Pi Durable agent inside a manually started
Ubuntu VM. The host has QEMU init/start scripts and a browser. The guest has a
thin TypeScript HTTP service, Pi Durable 1.5.0, SQLite and a separate work UID.
The unit of use is a conversation and its working directory. An answered
conversation accepts more input. At most one conversation executes; other
execution requests receive busy, without a host FIFO or scheduler.

Do not add a host daemon, VM manager, automatic host startup, Proxmox,
Firecracker, distributed workers, workflow engine or plugin management system.
Do not add job classifications, service-specific connectors or ledgers, fixed
output formats, artifact registration/versioning, or validation/completion gates.
A response ending is not proof that its contents are correct. Use ordinary
CLI/API/scripts and configured MCP tools for new kinds of work.

## Work and delivery

Inspect the worktree and preserve unrelated changes, user data and Git history.
Never delete or automatically convert legacy databases or work directories.
The current database is control/conversations-v1.sqlite; work is under
work/conversations/. The previous state.sqlite and work/jobs/ remain untouched.

Use Japanese for UI and README, English for code, comments and commits. Keep
maintained prose in README.md and AGENTS.md; executable examples in examples/.
Do not add a docs tree, design records, roadmaps or historical/progress reports.
Use short-lived codex/type/description branches, Conventional Commits and
.github/pull_request_template.md. Update the existing unmerged PR when working
on it. No direct master push, shared-history rewriting, merge or release without
explicit authorization. Do not commit credentials, machine state, dependencies,
generated output or live provider responses.

## Implementation boundaries

- src/service.ts and src/state.ts: conversation metadata in a Pi Document,
  atomic input admission, one-active-conversation gate and interruption handling.
- src/tools.ts: relay unmodified Pi read/write/edit/bash definitions to the work
  UID; expose tools enumerated by configured MCP servers.
- src/execution/: bounded stdio adapter, standard Pi tools/NodeExecutionEnv,
  official MCP client and bounded attachment/output transfers.
- src/provider.ts: model dispatch limit and active-conversation binding.
- src/server.ts and web/: authentication, conversation projections and SSE.
  Use assistant-ui React primitives with an external-store adapter to the existing
  API; Pi remains the only conversation/execution owner. Never enable client-side
  tool execution or cloud persistence. Bundle browser dependencies locally with
  esbuild and use Bootstrap 6 utilities. Keep Markdown HTML and remote images
  disabled; allow only safe external links and scoped output downloads. Keep UI
  copy to labels, status and actionable errors; avoid explanatory prose.
- vm/: manual host scripts, initial disk setup, fixed UID launcher and guest units.

Inspect installed SDK exports/declarations before changing integration code.
Use public Pi APIs. Keep inputs and their metadata in the same transaction;
transaction drafts must not escape commits. Pi owns its tasks, inbox, history
and tool replay policy. Do not implement a second workflow model or directly edit
SDK tables. Execution tools remain replay-unsafe. Reopen never resumes inference
or commands without explicit user input; preserve unapplied input when aborting.
A failed storage session must stop and reopen, not continue accepting input.

## Safety

Keep the DB, model credentials and service installation separate from arbitrary
work code. No project code or executable MCP server runs as agent-control.
The fixed root-owned sudo launcher permits only agent-work, no arguments and
no SETENV. Apply NoNewPrivileges after the UID switch. Build a clean work
environment; never inherit control credentials, host homes or SSH agents.
Never silently fall back when mount/UUID, UID, firewall or cleanup is unavailable.
Retain systemd control-group cleanup and bounded tool duration/output.

Explicitly configured work-side CLI/MCP credentials delegate their authority to
the agent. Do not claim prompt restrictions or UI approval completely constrain
a freely callable authenticated shell. Do not infer credentials, billing,
company access or disclosure permission. Use stdio MCP with the existing official
client; no discovery service, custom MCP protocol or global connector framework.

Keep downloads within outputs/: reject absolute paths, traversal, symlinks,
nonregular files, hardlinks, oversized files and path replacement during reads.
Uploads go explicitly into attachments/. Files are mutable workspace files,
not immutable artifacts. Keep authentication, Host/Origin/CSRF checks and safe
text rendering. External content is untrusted input, never a permission grant.

Stop and restart preserve history and files; they do not restore OS stacks or
guarantee external exactly-once. Interrupted commands are not blindly resent.
Inspect ordinary CLI/API state and ask the user in the conversation when uncertain.
No service-specific reconciliation system is needed.

## Verification

Use Node.js 26.13.0 and npm. Install separately from build:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install chromium
npm run verify
```

Linux needs Git, Python 3 and Chromium system libraries. Build never installs
dependencies. verify includes format, types, build, Python unit tests, actual
Pi/SQLite/file/process/HTTP/MCP tests, browser E2E and entry-point help. The faux
provider avoids paid inference. Playwright is a test dependency, not an application
pipeline. Use narrow checks first; tests must prevent concrete failures.

Guest tests require explicit AGENT_GUEST_TEST=1, administrator privileges and a
dedicated provisioned VM with agent.service explicitly stopped. Live tests require
explicit opt-in, a reviewed prompt and private credential file. They never belong
in default CI. Missing prerequisites are blocked (exit 77), not pass. Report real
WHPX/KVM, guest UID/network/cgroup, live-service and model-quality acceptance
separately. Nonprivileged same-UID fixtures do not establish isolation. Keep
generated evidence in ignored test-results/ or CI artifacts.
