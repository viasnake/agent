# Context integrity review

The host treats protected context and model-reported context concerns as
fail-closed boundaries. Structural compaction integrity is checked before a
candidate is adopted. A model may report a missing condition, contradiction,
or repeated exploration with bounded untrusted evidence and references it is
authorized to see; the report is not a semantic proof.

An active issue is persisted on the run and blocks later tools, inference
reservations, context transforms, and final success. The host does not drop
the issue, reset permissions, increase budgets, or automatically retry or
resume. `/context-review <run-id>` prints an immutable preview. Only an
explicit `--confirm <binding> --note <text>` acknowledgement under the
current run binding records the human decision. The run remains waiting for
an explicit resume or a new request, and terminal runs are never resurrected.

The repeated-read heuristic examines only completed, artifact-backed
exploration reads in a bounded operation window. Four exact repeats with the
same parsed arguments and result digest are a conservative host signal; it is
not a universal semantic duplicate detector. TUI preview and rendered
acceptance are separate follow-up work.
