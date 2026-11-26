import { useMemo } from "react";

type Line = {
  text: string;
  kind: "hunk" | "added" | "removed" | "context" | "note";
  old?: number;
  next?: number;
};

export function patchLines(patch: string, showFiles = false) {
  const source = patch.split("\n");
  if (source.at(-1) === "") source.pop();
  const lines: Line[] = [];
  let old = 0;
  let next = 0;
  let inHunk = false;
  for (const text of source) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (text.startsWith("diff --git ")) {
      inHunk = false;
      if (showFiles) lines.push({ text, kind: "note" });
    } else if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[2]);
      inHunk = true;
      lines.push({ text, kind: "hunk" });
    } else if (!inHunk) {
      if (!/^(diff --git |index |--- |\+\+\+ )/.test(text))
        lines.push({ text, kind: "note" });
    } else if (text.startsWith("+")) {
      lines.push({ text, kind: "added", next: next++ });
    } else if (text.startsWith("-")) {
      lines.push({ text, kind: "removed", old: old++ });
    } else if (text.startsWith(" ")) {
      lines.push({ text, kind: "context", old: old++, next: next++ });
    } else {
      lines.push({ text, kind: "note" });
    }
  }
  return lines;
}

export function GitPatch({
  text,
  showFiles = false,
}: {
  text: string;
  showFiles?: boolean;
}) {
  const lines = useMemo(() => patchLines(text, showFiles), [text, showFiles]);
  // Bound the number of DOM nodes for patches containing many very short lines.
  if (!lines.length || lines.length > 2500)
    return (
      <pre className="git-review-patch m-0 p-3" tabIndex={0} aria-label="差分">
        {text}
      </pre>
    );
  return (
    <div
      className="git-review-patch"
      tabIndex={0}
      role="region"
      aria-label="差分（旧・新の行番号）"
    >
      <div className="git-patch-lines">
        {lines.map((line, index) => (
          <div className={`git-patch-line git-patch-${line.kind}`} key={index}>
            <span aria-hidden="true">{line.old}</span>
            <span aria-hidden="true">{line.next}</span>
            <code>{line.text}</code>
          </div>
        ))}
      </div>
    </div>
  );
}
