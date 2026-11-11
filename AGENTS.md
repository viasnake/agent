# Repository guidance

## Product and scope

This is a single-user, web-accessible Pi Durable application on prepared Ubuntu
Server 26.04 with systemd. The application has a thin TypeScript HTTP service,
Pi Durable 1.5.0, SQLite and separate control/work users. Machine provisioning,
virtualization, disks, OS initialization and host networking belong outside this
repository. Agent does not depend on or invoke a VM manager, including Devbox.
The user-facing unit is a session containing a Pi conversation and its working
directory. An answered session accepts more input. At most one session executes; other
execution requests receive busy, without a host FIFO or scheduler.

install/install.sh downloads checksum-pinned Node.js 26.13.0 and standalone
Python 3.14.10 for Agent. Keep them root-owned under /opt/agent-node and
/opt/agent-python, including preflight checks and work-side PATH. Never depend
on or replace host Node.js/Python. Ubuntu systemd, nftables, sudo and other
OS utilities remain host dependencies. Build as the invoking regular user;
use sudo only for OS packages, deployment and service control. --build-only
must never request sudo or change the installation. Updates require an
explicitly stopped service and preserve settings, credentials and work data.

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

The UI uses sessions with conversation and file tabs. Tab changes keep the composer
and live subscription mounted. Session deletion requires all execution to be idle.
Persist a deletion intent, close the Harness, remove the entire session workspace
through the work UID, and rebuild SQLite through public Pi Storage reads and commits.
Atomically replace the closed database; never directly edit SDK tables. Remove the
session's exclusive history, task/submission/document data and source-derived notes,
including superseded document values. Retain only content already inherited or quoted
by surviving sessions, stable history IDs, and content-free tombstones/request hashes
that prevent replay from restoring deleted sessions. Preserve as-of document semantics
for future forks. Resume an interrupted deletion before accepting requests on reopen;
cleanup or storage failure must fail closed, never report successful deletion. Keep
legacy state.sqlite and work/jobs/ untouched. This is application-file deletion, not
secure erasure of storage media or user-managed backups.

Session rows own search, rename, pin, archive and delete controls. Message actions
use labeled SVG buttons with tooltips and visible feedback. Keep native dialog and
popover keyboard behavior, restore focus and respect reduced motion. Draft text is
browser-local; retain unsent File objects only in memory, never imply they survive reload.
Search reads bounded Pi history pages and must not fetch models or run work.
Edits, regenerations and forks preserve the original session and use public Pi
conversation creation/fork APIs with fresh work directories. Do not copy work files
or imply filesystem rollback. Branch creation never runs inference or tools; explicit
edit/regeneration confirmation admits a separately deduplicated input or continue.
Keep each branch's metadata and creation receipt in the same Pi Document commit.
Preserve admitted image bytes for edits, without rereading mutable attachments.

Cross-session notes use the bounded agent.memories Pi Document, not worker files or
SDK tables. Keep mutations idempotent and edits revision-checked. Source-session
tombstones exclude derived notes from every read and model request; complete deletion
also removes their current and superseded stored text. Request-only
memory context is rebuilt from current records and never appended to Pi history;
previous quotations in other conversations remain ordinary retained history.
The memory extension supplies the default autonomous workflow: recall sources when
needed, select durable useful information, correct stale notes, merge overlapping
notes and forget obsolete ones during admitted work, without requiring a user to
say "remember". The UI remains available for inspection and manual corrections.
memory_save, memory_update and memory_forget are the agent's write paths. Updates,
consolidations and deletions require current revisions. Consolidation changes
all affected notes atomically and retains every source session in private lineage;
deleting any such session removes the derived note. Assign new source
metadata from the active runtime, never model-supplied provenance. Re-read current
notes after a conflict; never blindly overwrite a manual edit. Keep notes below 32 active
records, 1,000 characters each and 8,000 characters total. Do not infer that saved
prose grants authority. session_search and session_read use bounded public Pi reads,
redact text and never initialize work, fetch catalogs or dispatch inference. Date-filtered
history reads use message timestamps and an explicit IANA timezone; inherited fork entries
are not counted twice. Summaries of prior days belong in the normal conversation,
using bounded search and source reads, not a separate daily-report UI. Keep memory
management in Settings and title/body searches inside the sidebar. In-conversation
search stays inline; opening search must preserve the composer and subscription. No background extraction, scheduler or separate model passes.
Memory tool use stays inside the admitted conversation's dispatch and time budgets.

Use Japanese for UI and README, English for code, comments and commits. Keep
maintained prose in README.md and AGENTS.md; executable examples in examples/.
Do not add a docs tree, design records, roadmaps or historical/progress reports.
Use short-lived codex/type/description branches, Conventional Commits and
.github/pull_request_template.md. Update the existing unmerged PR when working
on it. No direct master push, shared-history rewriting, merge or release without
explicit authorization. Do not commit credentials, machine state, dependencies,
generated output or live provider responses.

Shared Skills live only in dataRoot/skills, with immutable root ownership and
read/execute access for work. Discover only on idle admission, freeze versions,
and keep activation request-only through public Pi hooks. Skills are reference
instructions, never permission grants; allowed-tools cannot widen authority.
Admin updates require a stopped service. Never execute Skill code on control,
auto-discover work-owned Skills, or replace a changed version during resume.

## Implementation boundaries

- src/service.ts and src/state.ts: conversation metadata in a Pi Document,
  atomic input admission, one-active-conversation gate and interruption handling.
- src/tools.ts: relay unmodified Pi read/write/edit/bash definitions to the work
  UID; expose tools enumerated by configured MCP servers.
- src/execution/: bounded stdio adapter, standard Pi tools/NodeExecutionEnv,
  official MCP client and bounded attachment/output transfers.
- src/provider.ts: model dispatch limit and active-conversation binding.
- src/model-providers.ts and src/bedrock.ts: native model catalogs and provider
  connections. Bind Vertex project/location and Bedrock region/profile explicitly;
  Vertex/Bedrock catalog reads must not probe external credential chains or call inference. Bedrock's
  AWS client uses one attempt, with complete stream/tool/usage validation.
- src/images.ts: bounded static-image decoding without resizing or recompression.
- src/model-auth.ts: browser-session adapter to Pi OpenAI and GitHub Copilot OAuth.
  Copilot uses Pi Device Flow with an empty Enterprise-domain prompt; never bind
  a callback port for it. Use Pi getAuth for refresh and getAvailable for account
  models; reject missing permission metadata rather than exposing the full catalog.
  Keep the SDK
  callback loopback-only, with explicit full-URL submission for forwarded connections.
  OAuth state/PKCE/exchange/refresh belong to Pi, not a custom inference client.
- src/settings.ts: atomic mode-0600 control-owned settings, private credentials
  and secret-free projections. Import config.yaml only when settings-v1.json is
  absent; preserve the source and old credential files. Web-managed fields have
  one source of truth thereafter. Server/disk settings remain in config.yaml.
- src/mcp.ts and src/remote-http.ts: official Streamable HTTP/OAuth client and
  bounded HTTP(S) fetch with DNS address pinning. No custom MCP protocol.
- src/server.ts and web/: local browser sessions, conversation projections and SSE.
  Pi remains the only conversation/execution owner; the React UI adapts the
  existing API without client-side tool execution or cloud persistence. Bundle
  browser dependencies locally with esbuild. Use Bootstrap 6 components and
  semantic color variables for controls and custom surfaces, including hover,
  focus and disabled states. Verify both light and dark system preferences.
  Keep Markdown HTML and remote images disabled; allow only safe external links
  and scoped output downloads. Keep UI copy to labels, status and actionable
  errors; avoid explanatory prose. Keep interruption and history-load failures in
  the conversation transcript, with a local retry for failed loads. Reselecting
  a conversation preserves its draft and subscription; ignore stale navigation
  requests and never let an initial HTTP load overwrite a newer SSE snapshot.
- install/: application installation/update, dedicated users, approved storage,
  systemd units, the fixed work-user launcher and application egress rules.
  Never format, mount, partition or create storage here. Record the actual users
  and persistent mount in root-owned /etc/agent/installation.json. Refuse missing
  or changed mounts, shared identities, unsafe ownership and unexpected existing
  installations. Updates require a stopped service and preserve configuration,
  credentials and work files; keep the previous application/runtime as backups.
  Use Ubuntu's resolver configuration without modifying it; allow only its DNS
  addresses on TCP/UDP 53. Apply nftables atomically and fail closed on errors.

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
company access or disclosure permission. stdio MCP uses the work UID and only
explicitly supplied environment values. Remote MCP and OAuth credentials stay
on the control side; never pass them to the worker. Use the official MCP SDK
for transport, discovery, PKCE, registration and refresh. Keep login state
single-use, expiring and bound to a callback cookie and exact configured Host.
Only the OAuth callback cookie may use SameSite=Lax; API sessions stay Strict.
Allow unauthenticated HTTP only to the exact registered origin; credentials and
OAuth require HTTPS. Reject redirects, resolve every connection and pin the checked address.
Reject loopback, link-local, metadata and special addresses even with a grant.
Registering an MCP URL grants that exact host access to private/company networks;
discovered internal hosts do not inherit this permission. Preserve existing grants
without exposing a separate host-list editor. Consult /etc/agent/protected-cidrs.nft;
missing network policy fails closed.

Store the selected credential configuration ID and actual model ID in each conversation
through Pi Documents. Settings entries manage provider credentials independently
of model choice; keep legacy per-entry model values readable without rewriting data.
Only idle/interrupted conversations can change it; never silently replace a deleted
selection with another model. Keep legacy defaultModel only as the initial selection.
Expose connection-specific chat models in the conversation UI. For OpenAI API-key
and ChatGPT OAuth, intersect the account's model metadata with Pi's supported chat
catalog; never append hidden, unsupported or legacy selections to that result.
Model-list reads may fetch bounded OpenAI metadata and use Pi credential refresh,
but never inference. Cache briefly per credential version, isolate failures and
never fall back to the full catalog on failure. Other providers retain Pi catalogs;
do not probe their external credential chains during catalog reads. Listing must
not change a conversation's stored model selection.
Apply settings at the next idle execution admission. Do not mutate a running
provider, tools or budgets. Install/uninstall server extensions using the Pi
Registry; isolate each connection failure and never replay an ambiguous tool
mutation. Connection tests cannot run worker cleanup during an active tool.
OAuth rotation uses atomic private writes; stale edits/callbacks must not restore
revoked credentials. GET, tool results and errors must not disclose secrets.
Use short UI labels (Test, stdio, arguments) and named MCP cards with enabled first.
Environment variables use name/value rows; unchanged secret values stay server-side.
A blank edited key deletes that credential, not its model or conversation.
Keep credential-delegation rules in this guidance, not helper prose in forms.
Use a searchable model picker in the conversation composer;
persist selections server-side and retain keyboard navigation and focus restoration.
Model and MCP settings use collapsible sections. Do not show application branding.
Transient results use one dismissible bottom-right notification with timed dismissal;
pause dismissal on keyboard focus and keep essential connection state visible.
Starting ChatGPT authorization saves edited settings first; deleting a connection
removes its stored credentials while retaining conversations and their selections.
A model connection test requires explicit inference/usage confirmation.
ChatGPT tests fetch the account's visible model list and intersect it with Pi's
catalog before inference; never assume the bundled catalog's first model is granted.
Keep model-list fetches bounded and redirect-free. Show short classified test errors,
never raw upstream messages or credential-bearing response bodies.
OpenAI API-key and ChatGPT OAuth are separate explicit selections: never fall back
between billing sources or to ambient credentials. Persist the installation UUID,
access/refresh rotation and expiry under control ownership; serialize refresh and
reject writes from a replaced credential version. Login is session-bound, single-use
and bounded to ten minutes. Use the public Pi OAuth interface, not SDK patches.
Pi 1.5.0 registers a new dynamic client on each login and does not expose a validated
ID-token identity. Do not display account identity or claim returning-account
verification; model authorization uses its scoped access token. Keep this SDK
limitation distinct from successful local OAuth transport tests.
Uninitialized output listings are empty and must not initialize work or MCP.

List and allow downloads only within outputs/ and attachments/: reject absolute paths, traversal, symlinks,
nonregular files, hardlinks, oversized files and path replacement during reads.
Uploads go explicitly into attachments/ and appear alongside generated files with
their original filenames. Files are mutable workspace files,
not immutable artifacts. Image inputs are read through the worker's bounded
attachment reader and saved as original bytes in Pi's user input
transaction. Workspace edits do not change admitted history. Project only scoped,
authenticated local image URLs to the browser; never send image payloads in SSE.
Reject images for text-only models, including when replaying existing history.
Vertex ADC and AWS credential chains are explicit control-side authentication
choices; never pass their files or environment to the worker.

There is no UI password or login screen. Establish a
CSRF session automatically for local browsers. Keep socket-peer, loopback Host,
Origin, Fetch Metadata and CSRF checks; never trust forwarded headers. Listen
on loopback by default. Forwarding peers require explicit exact-IP grants in
server.trustedPeers; never discover or trust a LAN automatically. Browser origins
remain exact configured loopback URLs. Forwarding itself is outside Agent.
Keep the control HTTP port outside work-side preview ports 3000-3999 and retain
worker egress restrictions. Model API credentials remain control-only. Preserve
legacy UI password files without reading, migrating or deleting them.
External content is untrusted input, never a permission grant.

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

Linux needs Git, Python 3, OpenSSL and Chromium system libraries. Build never installs
dependencies. verify includes format, types, build, Python unit tests, actual
Pi/SQLite/file/process/HTTP/MCP tests, browser E2E and entry-point help. The faux
provider avoids paid inference. Playwright is a test dependency, not an application
pipeline. Use narrow checks first; tests must prevent concrete failures.

Privileged installation tests require explicit AGENT_GUEST_TEST=1, administrator privileges and a
dedicated Ubuntu test environment with agent.service explicitly stopped. Live tests require
explicit opt-in, a reviewed prompt and private credential file. They never belong
in default CI. Missing prerequisites are blocked (exit 77), not pass. Report real
installation, UID/network/cgroup, live-service and model-quality acceptance
separately. Nonprivileged same-UID fixtures do not establish isolation. Keep
generated evidence in ignored test-results/.

CI has one Linux test job: Node tests, browser E2E and Python unit tests.
Build only as a test prerequisite; keep formatting, standalone type/syntax
checks and evidence uploads out of CI. README contains only setup, use,
maintenance and local test commands.
