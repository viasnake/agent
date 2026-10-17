# Context integrity review

The host treats protected context and model-reported context concerns as
fail-closed boundaries. Structural compaction integrity is checked before a
candidate is adopted. A model may report a missing condition, contradiction,
or repeated exploration with bounded untrusted evidence and references it is
authorized to see; the report is not a semantic proof.

An active issue is persisted on the run and blocks later tools, inference
reservations, context transforms, and final success. The host does not drop
the issue, reset permissions, increase budgets, or automatically retry or
resume. `agent context-review <run-id>` prints an immutable preview. Only an
explicit `--confirm <binding> --note <text>` acknowledgement under the
current run binding records the human decision. Acknowledgement is neither
semantic proof nor permission to change constraints, policy, or authority. The
run remains waiting for an explicit resume or a new request, and terminal runs
are never resurrected.

The repeated-read heuristic examines only completed, artifact-backed
exploration reads in a bounded operation window. Four exact repeats with the
same parsed arguments and result digest are a conservative host signal; it is
not a universal semantic duplicate detector. A changed result digest or an
intervening mutation resets that query's repeat window. Evidence and
references are task-scoped, and excluded sources cannot be used as a bypass.
Heuristic false positives are expected and require human review.

In the TUI, `/context-review` displays the pending concerns, literal evidence,
reference IDs and preserved policy/usage. Review the bounded note and confirm
explicitly; cancelling any dialog changes nothing. A changed conversation,
run, configuration or retained context invalidates the preview. Notes are
audit records, not new model instructions. Acknowledgement gives pending tasks
one additional attempt without resetting run-wide budgets, and never starts
the queue or resumes inference. Use a new request to change requirements;
terminal runs cannot be resumed. Rendered TUI acceptance and real-provider
semantic quality validation remain separate from automated tests.
