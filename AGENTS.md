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
- src/model-providers.ts and src/bedrock.ts: native model catalogs and provider
  connections. Bind Vertex project/location and Bedrock region/profile explicitly;
  catalog/settings reads must not probe credentials or call inference. Bedrock's
  AWS client uses one attempt, with complete stream/tool/usage validation.
- src/images.ts: bounded static-image decoding without resizing or recompression.
- src/model-auth.ts: browser-session adapter to Pi OpenAI OAuth; keep the SDK
  callback loopback-only, with explicit full-URL submission for QEMU users.
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
  errors; avoid explanatory prose.
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
Expose the Pi model catalog under each configured connection in the conversation UI.
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

Keep downloads within outputs/: reject absolute paths, traversal, symlinks,
nonregular files, hardlinks, oversized files and path replacement during reads.
Uploads go explicitly into attachments/. Files are mutable workspace files,
not immutable artifacts. Image inputs are read through the worker's bounded
attachment reader and saved as original bytes in Pi's user input
transaction. Workspace edits do not change admitted history. Project only scoped,
authenticated local image URLs to the browser; never send image payloads in SSE.
Reject images for text-only models, including when replaying existing history.
Vertex ADC and AWS credential chains are explicit control-side authentication
choices; never pass their files or environment to the worker.

There is no UI password or login screen. Establish a
CSRF session automatically for local browsers. Keep socket-peer, loopback Host,
Origin, Fetch Metadata and CSRF checks; never trust forwarded headers. QEMU
forwarding stays bound to host loopback. The guest accepts host-forwarded peers
at 10.0.2.2 and loopback only; do not expose it through LAN/public proxies.
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

Guest tests require explicit AGENT_GUEST_TEST=1, administrator privileges and a
dedicated provisioned VM with agent.service explicitly stopped. Live tests require
explicit opt-in, a reviewed prompt and private credential file. They never belong
in default CI. Missing prerequisites are blocked (exit 77), not pass. Report real
WHPX/KVM, guest UID/network/cgroup, live-service and model-quality acceptance
separately. Nonprivileged same-UID fixtures do not establish isolation. Keep
generated evidence in ignored test-results/ or CI artifacts.
