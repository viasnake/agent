import assert from "node:assert/strict";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readClipboardPng } from "../src/clipboard.js";
import {
  loadPreparedInput,
  maxZipEntryBytes,
  parseDocumentToken,
  prepareDocument,
} from "../src/documents.js";
import { prepareGitInput } from "../src/git-input.js";
import { AgentError } from "../src/types.js";
import {
  completed,
  fixture,
  gitWorkspace,
  ScriptedRuntime,
} from "./helpers.js";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Array<[string, Buffer]>): Buffer {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const filename = Buffer.from(name),
      crc = crc32(data),
      header = Buffer.alloc(30),
      directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, data);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + data.length;
  }
  const centralBytes = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

test("document selectors retain source locations and quoted table cells", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed())),
    markdown = join(f.root, "manual.md"),
    table = join(f.root, "table.csv");
  try {
    await writeFile(
      markdown,
      "# Intro\nskip\n## Setup\nfirst\n### Detail\nsecond\n## Next\nstop\n",
    );
    const selection = await prepareDocument(
      f.p,
      markdown,
      "manual.md::heading=Setup",
      10_000,
    );
    assert.match(selection.reference.locator, /lines 3-6/);
    assert.match(selection.text, /3: ## Setup/);
    assert.match(selection.text, /6: second/);
    await writeFile(
      table,
      'id,note\n001,"hello,\nworld"\n002,"escaped ""quote"""\n',
    );
    const rows = await prepareDocument(
      f.p,
      table,
      "table.csv::rows=2-3",
      10_000,
    );
    assert.match(rows.text, /2: \["001","hello,\\nworld"\]/);
    assert.match(rows.text, /3: \["002","escaped \\"quote\\""\]/);
  } finally {
    await f.cleanup();
  }
});

test("document tokens reject unknown, mismatched, duplicate and unsafe ranges", () => {
  for (const token of [
    "report.pdf::rows=2-3",
    "book.xlsx::sheet=Sales::sheet=Other",
    "manual.md::lines=2-999999999999999999999999",
    "manual.md::unknown=1",
  ])
    assert.throws(() => parseDocumentToken(token), AgentError);
});

test("structured parsers reject malformed cells, YAML aliases, and deep JSON", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed())),
    csv = join(f.root, "bad.csv"),
    yaml = join(f.root, "alias.yaml"),
    json = join(f.root, "deep.json");
  try {
    await writeFile(csv, 'id,note\n1,"unclosed\n');
    await assert.rejects(
      prepareDocument(f.p, csv, "bad.csv", 10_000),
      /Malformed quoted table cell/,
    );
    await writeFile(yaml, "base: &base [one]\ncopy: *base\n");
    await assert.rejects(
      prepareDocument(f.p, yaml, "alias.yaml", 10_000),
      /YAML aliases are not permitted/,
    );
    await writeFile(json, `${"[".repeat(66)}0${"]".repeat(66)}`);
    await assert.rejects(
      prepareDocument(f.p, json, "deep.json", 10_000),
      /nesting or cell limit/,
    );
  } finally {
    await f.cleanup();
  }
});

test("Office extraction preserves block order and rejects archive and XML hazards", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed())),
    path = join(f.root, "report.docx"),
    xml = Buffer.from(
      '<w:document xmlns:w="urn:word"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell 001</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>End</w:t></w:r></w:p></w:body></w:document>',
    );
  try {
    await writeFile(path, zip([["word/document.xml", xml]]));
    const prepared = await prepareDocument(f.p, path, "report.docx", 10_000),
      heading = prepared.text.indexOf("heading Heading1: Title"),
      cell = prepared.text.indexOf("table row 1 cell 1: Cell 001"),
      end = prepared.text.indexOf("paragraph: End");
    assert.ok(heading >= 0 && heading < cell && cell < end);
    await writeFile(
      path,
      zip([["word/document.xml", Buffer.from("<!DOCTYPE x><x/>")]]),
    );
    await assert.rejects(
      prepareDocument(f.p, path, "report.docx", 10_000),
      /DTD and entity/,
    );
    await writeFile(
      path,
      zip([
        ["word/document.xml", xml],
        ["word/document.xml", xml],
      ]),
    );
    await assert.rejects(
      prepareDocument(f.p, path, "report.docx", 10_000),
      /Duplicate Office entry/,
    );
    await writeFile(
      path,
      zip([["word/document.xml", Buffer.alloc(maxZipEntryBytes + 1)]]),
    );
    await assert.rejects(
      prepareDocument(f.p, path, "report.docx", 10_000),
      /exceeds 8000000 bytes/,
    );
  } finally {
    await f.cleanup();
  }
});

test("oversized selections are explicit and remain readable after source deletion", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed())),
    path = join(f.root, "large.txt");
  try {
    await writeFile(path, "0123456789".repeat(2000));
    const prepared = await prepareDocument(f.p, path, "large.txt", 1200);
    assert.equal(prepared.reference.partial, true);
    assert.ok(Buffer.byteLength(prepared.text) <= 8000);
    assert.match(prepared.text, /PARTIAL/);
    await unlink(path);
    assert.equal(
      (await loadPreparedInput(f.p, prepared.reference)).text,
      prepared.text,
    );
  } finally {
    await f.cleanup();
  }
});

test("Git attachments are bounded diffs and clipboard failure gives the file fallback", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const workspace = await gitWorkspace(f.root, { "README.md": "before\n" });
    await writeFile(join(workspace, "README.md"), "before\nafter\n");
    const diff = await prepareGitInput(
      f.p,
      workspace,
      "git:working",
      100_000,
      AbortSignal.timeout(5000),
    );
    assert.match(diff.text, /\+after/);
    assert.match(diff.reference.locator, /read-only Git working/);
    await writeFile(join(workspace, ".env"), "not-a-real-secret");
    await assert.rejects(
      prepareGitInput(
        f.p,
        workspace,
        "git:status",
        100_000,
        AbortSignal.timeout(5000),
      ),
      { code: "GIT_SECRET_PATH" },
    );
    await assert.rejects(
      readClipboardPng("freebsd"),
      /Save the image as a PNG/,
    );
  } finally {
    await f.cleanup();
  }
});
