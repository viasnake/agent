import assert from "node:assert/strict";
import { test } from "node:test";
import { patchLines } from "../web/git-patch.js";

test("Git patch lines keep old and new numbers across additions, deletions and multiple hunks", () => {
  assert.deepEqual(
    patchLines(
      [
        "diff --git a/notes b/notes",
        "index 0000000..1111111 100644",
        "--- a/notes",
        "+++ b/notes",
        "@@ -2,2 +3,3 @@",
        " context",
        "--- a line that looks like a header",
        "+new",
        "+++ still source text",
        "@@ -10 +12,0 @@",
        "-removed",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    ),
    [
      { kind: "hunk", text: "@@ -2,2 +3,3 @@" },
      { kind: "context", text: " context", old: 2, next: 3 },
      { kind: "removed", text: "--- a line that looks like a header", old: 3 },
      { kind: "added", text: "+new", next: 4 },
      { kind: "added", text: "+++ still source text", next: 5 },
      { kind: "hunk", text: "@@ -10 +12,0 @@" },
      { kind: "removed", text: "-removed", old: 10 },
      { kind: "note", text: "\\ No newline at end of file" },
    ],
  );
  assert.deepEqual(patchLines("old mode 100644\nnew mode 100755\n"), [
    { kind: "note", text: "old mode 100644" },
    { kind: "note", text: "new mode 100755" },
  ]);
});
