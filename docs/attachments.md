# Document and input attachments

Text documents are read into private, content-addressed snapshots before preview. The selected text, source digest, format, selector, byte counts, and source locator are kept with the queued request, so later edits or deletion of the source do not change confirmed queued content. Raw and selected attachments remain private to the owner; model tools can access only references authorized by the current run.

Use `@path` for a whole document or `@"path with spaces::selector=value"` for a selection:

- `@"README.md::lines=10-30"` and `@"manual.md::heading=Setup"`
- `@"report.pdf::pages=2-3::images=yes"` for at most 20 text pages and the remaining image slots
- `@"book.xlsx::sheet=売上::rows=2-20"` and `@"slides.pptx::slides=1-3"`
- CSV/TSV `::rows=...`; JSON and YAML retain their hierarchy

Supported document formats are TXT, Markdown, JSON, YAML, CSV, TSV, PDF, DOCX, PPTX, and XLSX. Raw files are limited to 20 MB. Office ZIP input is limited to 2,000 entries, 8 MB per decompressed entry and 50 MB total; malformed, encrypted, unsafe, DTD-bearing, or entity-bearing input is rejected. Office formulas are reported as formulas and cached values, never recalculated. Large selections are explicitly marked partial and include narrower-selection guidance.

## Explicit Skills

`/skills` lists workspace-local `skills/<name>/SKILL.md` entrypoints. `/skills relative/path/SKILL.md` selects another safe workspace-relative entrypoint. Review the complete procedure, optionally select text references from its `references/` directory, then confirm adding the selection to the existing draft. This operation never sends a model request. The draft contains `@"skill:skills/<name>/SKILL.md"` and ordinary `@".../references/file.md"` attachments; remove these tokens to cancel before sending. Draft tokens survive restart but do not constitute send approval.

Skills are nonempty UTF-8 files, at most 64,000 bytes, with no partial extraction or selectors. They must fit completely in the request input budget. Discovery is bounded to 200 directory entries and 10 seconds; skill discovery searches one directory level, and reference discovery two. The picker reports incomplete listings and skipped unsafe or oversized entries. Up to seven text references may be selected; all attachments still share the existing eight-document and byte limits. Reference extensions in the picker are Markdown, TXT, JSON, YAML, CSV and TSV. Other documents require explicit ordinary attachment selection.

The final send preview rereads the original files and displays the selected text, origin, hashes, classification and destinations. Once confirmed, the queued request retains immutable, hash-checked snapshots even if originals change or disappear. CLI callers may explicitly select `--workspace <project> --input skill:skills/<name>/SKILL.md`; use `--prepare-only` to inspect the resulting run without inference. CLI selection is explicit but does not add an interactive confirmation prompt.

Selection is scoped to the current request, not a permanently enabled plugin. The run records selected skill source IDs and hashes; source read operations record actual reads, not proof that a model followed the procedure correctly. Historical skill sources may remain available as conversation evidence but are not automatically selected on later turns. Reattach a skill to select it again. `/sources` excludes a sent source using the existing source-family controls; it does not erase previously generated text.

Skill text, frontmatter, links and scripts are untrusted references. They do not grant tools, credentials, network access or write permission, and cannot override user constraints or approval/disclosure policies. Frontmatter is not interpreted as executable configuration. Referenced files are never automatically attached, and scripts are not automatically executed. SDK skill/extension discovery remains disabled. Absolute paths, traversal, links, special files and protected locations (including `.agents`) remain unavailable; place the intended procedure in a safe workspace `skills/` directory rather than enabling implicit global/project configuration loading.

PDF conversion requires Poppler inside the configured Bubblewrap or rootless Podman sandbox. There is no host-process fallback or automatic download. If the sandbox tools are missing, configure `pdfinfo`, `pdftotext`, and `pdftoppm` inside the sandbox image before selecting PDF content.

`@git:status`, `@git:working`, `@git:staged`, `@git:commit:<full-hash>`, and `@git:<full-hash>..<full-hash>` attach bounded read-only repository context. `/git` displays branch, status, and recent commits. Git input never applies, commits, or resets changes; paths identified as secret or protected are rejected.

Git comparisons use raw blob and guarded worktree bytes. They do not apply Git attributes, clean filters, text conversion, working-tree encoding, or line-ending normalization. Untracked file names may appear in status, but their contents are not attached.

`/images crop <id> <x> <y> <width> <height>` and `/images mask ...` create new immutable derivatives and remove the source from active model context. `/images remove <id>` excludes a retained image; `/images compare <before-id> <after-id>` records order without claiming semantic or quantitative comparison accuracy.

`/clipboard` stages a bounded PNG from `wl-paste` or `xclip` on Linux, or `pngpaste` on macOS, in private local storage. It does not send the image: the next ordinary request still requires preview approval. If no adapter is available, save the PNG and attach it with `@path`; over SSH, use `scp` or `sftp` to place it in the workspace first.
