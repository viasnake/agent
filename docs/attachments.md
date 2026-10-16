# Document and input attachments

Text documents are read into private, content-addressed snapshots before preview. The selected text, source digest, format, selector, byte counts, and source locator are kept with the queued request, so later edits or deletion of the source do not change confirmed queued content. Raw and selected attachments remain private to the owner; model tools can access only references authorized by the current run.

Use `@path` for a whole document or `@"path with spaces::selector=value"` for a selection:

- `@"README.md::lines=10-30"` and `@"manual.md::heading=Setup"`
- `@"report.pdf::pages=2-3::images=yes"` for at most 20 text pages and the remaining image slots
- `@"book.xlsx::sheet=売上::rows=2-20"` and `@"slides.pptx::slides=1-3"`
- CSV/TSV `::rows=...`; JSON and YAML retain their hierarchy

Supported document formats are TXT, Markdown, JSON, YAML, CSV, TSV, PDF, DOCX, PPTX, and XLSX. Raw files are limited to 20 MB. Office ZIP input is limited to 2,000 entries, 8 MB per decompressed entry and 50 MB total; malformed, encrypted, unsafe, DTD-bearing, or entity-bearing input is rejected. Office formulas are reported as formulas and cached values, never recalculated. Large selections are explicitly marked partial and include narrower-selection guidance.

PDF conversion requires Poppler inside the configured Bubblewrap or rootless Podman sandbox. There is no host-process fallback or automatic download. If the sandbox tools are missing, configure `pdfinfo`, `pdftotext`, and `pdftoppm` inside the sandbox image before selecting PDF content.

`@git:status`, `@git:working`, `@git:staged`, `@git:commit:<full-hash>`, and `@git:<full-hash>..<full-hash>` attach bounded read-only repository context. `/git` displays branch, status, and recent commits. Git input never applies, commits, or resets changes; paths identified as secret or protected are rejected.

Git comparisons use raw blob and guarded worktree bytes. They do not apply Git attributes, clean filters, text conversion, working-tree encoding, or line-ending normalization. Untracked file names may appear in status, but their contents are not attached.

`/images crop <id> <x> <y> <width> <height>` and `/images mask ...` create new immutable derivatives and remove the source from active model context. `/images remove <id>` excludes a retained image; `/images compare <before-id> <after-id>` records order without claiming semantic or quantitative comparison accuracy.

`/clipboard` stages a bounded PNG from `wl-paste` or `xclip` on Linux, or `pngpaste` on macOS, in private local storage. It does not send the image: the next ordinary request still requires preview approval. If no adapter is available, save the PNG and attach it with `@path`; over SSH, use `scp` or `sftp` to place it in the workspace first.
