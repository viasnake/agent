import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { readClipboardPng } from "../src/clipboard.js";
import {
  loadPreparedInput,
  maxZipEntryBytes,
  parseDocumentToken,
  prepareDocument,
} from "../src/documents.js";
import {
  prepareGitInput,
  readGitStatus,
  selectGitInput,
} from "../src/git-input.js";
import { extractOffice } from "../src/office.js";
import { extractPdf } from "../src/pdf.js";
import { emptyConversationContext } from "../src/context.js";
import { Sandbox } from "../src/sandbox.js";
import { AgentError } from "../src/types.js";
import { cleanEnvironment, runProcess } from "../src/process.js";
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

test("unknown text, exact structured source, and bounded row windows preserve locations", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed())),
    source = join(f.root, "module.py"),
    json = join(f.root, "exact.json"),
    yaml = join(f.root, "exact.yaml"),
    table = join(f.root, "large.csv"),
    columns = join(f.root, "columns.tsv");
  try {
    await writeFile(source, "first\nsecond\nthird\n");
    const line = await prepareDocument(
      f.p,
      source,
      "module.py::lines=2-3",
      1000,
    );
    assert.equal(line.text, "2: second\n3: third");
    assert.equal(line.reference.format, "text");
    await writeFile(json, '{"large":9007199254740993,"exponent":1e+400}\n');
    const exactJson = await prepareDocument(f.p, json, "exact.json", 1000);
    assert.equal(
      exactJson.text,
      '{"large":9007199254740993,"exponent":1e+400}\n',
    );
    await writeFile(yaml, "large: 9007199254740993\nexponent: 1e+400\n");
    const exactYaml = await prepareDocument(
      f.p,
      yaml,
      "exact.yaml::lines=1-1",
      1000,
    );
    assert.equal(exactYaml.text, "1: large: 9007199254740993");
    await assert.rejects(
      prepareDocument(f.p, source, "module.py::lines=1::heading=Title", 1000),
      { code: "INPUT_SELECTOR" },
    );

    await writeFile(
      table,
      `id\n${Array.from({ length: 2100 }, (_, index) => index + 1).join("\n")}\n`,
    );
    const farWindow = await prepareDocument(
      f.p,
      table,
      "large.csv::rows=2099-2100",
      1000,
    );
    assert.match(farWindow.text, /2099: \["2098"\]/);
    assert.match(farWindow.text, /2100: \["2099"\]/);
    assert.equal(farWindow.reference.partial, false);
    const defaultWindow = await prepareDocument(
      f.p,
      table,
      "large.csv",
      100_000,
    );
    assert.equal(defaultWindow.reference.locator, "rows 1-2000");
    assert.equal(defaultWindow.reference.partial, true);
    assert.match(defaultWindow.text, /PARTIAL: table has more rows/);
    await assert.rejects(
      prepareDocument(f.p, table, "large.csv::rows=2102", 1000),
      { code: "INPUT_SELECTOR" },
    );
    await writeFile(
      columns,
      `${Array.from({ length: 256 }, (_, index) => `v${index}`).join("\t")}\n`,
    );
    const columnOutput = await prepareDocument(
      f.p,
      columns,
      "columns.tsv",
      100_000,
    );
    assert.equal(JSON.parse(columnOutput.text.slice(3)).length, 256);
    await writeFile(
      columns,
      `${Array.from({ length: 257 }, (_, index) => `v${index}`).join("\t")}\n`,
    );
    await assert.rejects(
      prepareDocument(f.p, columns, "columns.tsv", 100_000),
      { code: "DOCUMENT_LIMIT" },
    );
  } finally {
    await f.cleanup();
  }
});

test("CSV preserves explicit empty logical records without adding a trailing phantom row", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed())),
    path = join(f.root, "records.csv");
  try {
    await writeFile(path, 'a\n\n""\n"two\nlines"\n');
    const records = await prepareDocument(
      f.p,
      path,
      "records.csv::rows=1-4",
      10_000,
    );
    assert.equal(
      records.text,
      '1: ["a"]\n2: [""]\n3: [""]\n4: ["two\\nlines"]',
    );
    assert.equal(records.reference.locator, "rows 1-4");
    await writeFile(path, "a\n");
    const trailing = await prepareDocument(f.p, path, "records.csv", 10_000);
    assert.equal(trailing.reference.locator, "rows 1-1");
    assert.equal(trailing.text, '1: ["a"]');
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
      zip([
        [
          "word/document.xml",
          Buffer.from(
            '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t><![CDATA[ leading ]]></w:t><w:tab/><w:br/><w:t> trailing </w:t></w:r></w:p></w:body></w:document>',
          ),
        ],
      ]),
    );
    const controls = await prepareDocument(f.p, path, "controls.docx", 10_000);
    assert.match(controls.text, /paragraph:  leading \t\n trailing /);
    const secondLine = await prepareDocument(
      f.p,
      path,
      "controls.docx::lines=2-2",
      10_000,
    );
    assert.match(secondLine.text, /^2:  trailing /);
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
      zip([
        ["word/document.xml", xml],
        ["../escape.xml", Buffer.from("<x/>")],
      ]),
    );
    await assert.rejects(prepareDocument(f.p, path, "report.docx", 10_000));
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

test("PPTX and XLSX preserve namespaced relationships, formulas, and safe indexes", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed())),
    presentationPath = join(f.root, "deck.pptx"),
    workbookPath = join(f.root, "book.xlsx"),
    presentation = Buffer.from(
      '<p:presentation xmlns:p="urn:presentation" xmlns:q="http://purl.oclc.org/ooxml/officeDocument/relationships"><p:sldIdLst><p:sldId q:id="s1"/></p:sldIdLst></p:presentation>',
    ),
    presentationRels = Buffer.from(
      '<Relationships><Relationship Id="s1" Target="slides/slide1.xml"/></Relationships>',
    ),
    slide = Buffer.from(
      '<p:sld xmlns:p="urn:presentation" xmlns:a="urn:drawing"><a:p><a:t><![CDATA[Strict title]]></a:t><a:br/><a:t>Second line</a:t></a:p></p:sld>',
    ),
    workbook = Buffer.from(
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales" r:id="sheet1"/></sheets></workbook>',
    ),
    workbookRels = Buffer.from(
      '<Relationships><Relationship Id="sheet1" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    sheet = Buffer.from(
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><f t="shared" si="0"></f><v>9007199254740993</v></c></row></sheetData></worksheet>',
    );
  try {
    await writeFile(
      presentationPath,
      zip([
        ["ppt/presentation.xml", presentation],
        ["ppt/_rels/presentation.xml.rels", presentationRels],
        ["ppt/slides/slide1.xml", slide],
      ]),
    );
    const deck = await prepareDocument(
      f.p,
      presentationPath,
      "deck.pptx",
      10_000,
    );
    assert.match(deck.text, /slide 1: paragraph: Strict title/);
    assert.match(deck.text, /Second line/);

    await writeFile(
      workbookPath,
      zip([
        ["xl/workbook.xml", workbook],
        ["xl/_rels/workbook.xml.rels", workbookRels],
        ["xl/worksheets/sheet1.xml", sheet],
        [
          "xl/sharedStrings.xml",
          Buffer.from("<sst><si><t>Sales</t></si></sst>"),
        ],
      ]),
    );
    const index = await prepareDocument(f.p, workbookPath, "book.xlsx", 50_000);
    assert.match(index.text, /sheet 1: Sales/);
    assert.equal(index.reference.partial, true);
    assert.ok(Buffer.byteLength(index.text) <= 8_000);
    const sales = await prepareDocument(
      f.p,
      workbookPath,
      "book.xlsx::sheet=Sales::rows=1",
      50_000,
    );
    assert.match(sales.text, /A1: type=s raw="0" value="Sales"/);
    assert.match(
      sales.text,
      /B1: type=n formula\[type=shared, sharedIndex=0\]=""; cachedRaw="9007199254740993"; raw="9007199254740993" value="9007199254740993"/,
    );

    await writeFile(
      presentationPath,
      zip([
        ["ppt/presentation.xml", presentation],
        ["ppt/_rels/presentation.xml.rels", presentationRels],
        ["ppt/slides/slide1.xml", slide],
        [
          "ppt/slides/_rels/slide1.xml.rels",
          Buffer.from(
            '<Relationships><Relationship Id="outside" Target="https://example.invalid/x"/></Relationships>',
          ),
        ],
      ]),
    );
    await assert.rejects(
      prepareDocument(f.p, presentationPath, "deck.pptx", 10_000),
      /External Office relationships are not permitted/,
    );
    await writeFile(
      presentationPath,
      zip([
        ["ppt/presentation.xml", presentation],
        [
          "ppt/_rels/presentation.xml.rels",
          Buffer.from(
            '<Relationships><Relationship Id="s1" Target="../../outside.xml"/></Relationships>',
          ),
        ],
        ["ppt/slides/slide1.xml", slide],
      ]),
    );
    await assert.rejects(
      prepareDocument(f.p, presentationPath, "deck.pptx", 10_000),
      { code: "DOCUMENT_ARCHIVE" },
    );
    await writeFile(
      presentationPath,
      zip([
        ["ppt/presentation.xml", presentation],
        [
          "ppt/_rels/presentation.xml.rels",
          Buffer.from(
            '<Relationships><Relationship Id="s1" Target="slides/slide1.xml" Type="http://example.invalid/vba&#80;roject"/></Relationships>',
          ),
        ],
        ["ppt/slides/slide1.xml", slide],
      ]),
    );
    await assert.rejects(
      prepareDocument(f.p, presentationPath, "deck.pptx", 10_000),
      { code: "DOCUMENT_ARCHIVE" },
    );
    await writeFile(
      presentationPath,
      zip([
        [
          "[Content_Types].xml",
          Buffer.from(
            '<Types><Override ContentType="application/vnd.ms-word.document.macro&#69;nabled.main+xml"/></Types>',
          ),
        ],
        ["word/document.xml", Buffer.from("<document/>")],
      ]),
    );
    await assert.rejects(
      prepareDocument(f.p, presentationPath, "deck.pptx", 10_000),
      { code: "DOCUMENT_ARCHIVE" },
    );
    await writeFile(
      presentationPath,
      zip([
        [
          "ppt/presentation.xml",
          Buffer.from(
            presentation.toString().replace('q:id="s1"', 'q:id="missing"'),
          ),
        ],
        ["ppt/_rels/presentation.xml.rels", presentationRels],
        ["ppt/slides/slide1.xml", slide],
      ]),
    );
    await assert.rejects(
      prepareDocument(f.p, presentationPath, "deck.pptx", 10_000),
      /Missing slide relationship/,
    );
    await writeFile(
      presentationPath,
      zip([
        ["ppt/presentation.xml", presentation],
        [
          "ppt/_rels/presentation.xml.rels",
          Buffer.from(
            '<Relationships><Relationship Id="s1" Target="slides/missing.xml"/></Relationships>',
          ),
        ],
        ["ppt/slides/slide1.xml", slide],
      ]),
    );
    await assert.rejects(
      prepareDocument(f.p, presentationPath, "deck.pptx", 10_000),
      /Office relationship target is missing/,
    );
    await writeFile(
      presentationPath,
      zip([
        ["ppt/presentation.xml", presentation],
        ["ppt/_rels/presentation.xml.rels", presentationRels],
        ["ppt/slides/slide1.xml", slide],
        [
          "ppt/slides/_rels/slide1.xml.rels",
          Buffer.from(
            '<Relationships><Relationship Id="notes" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
          ),
        ],
      ]),
    );
    await assert.rejects(
      prepareDocument(f.p, presentationPath, "deck.pptx", 10_000),
      /Office relationship target is missing/,
    );
    await writeFile(
      presentationPath,
      zip([
        ["ppt/presentation.xml", presentation],
        ["ppt/_rels/presentation.xml.rels", presentationRels],
        ["ppt/slides/slide1.xml", slide],
        [
          "custom/_rels/unused.xml.rels",
          Buffer.from(
            '<Relationships><Relationship Id="unused" Target="missing.xml"/></Relationships>',
          ),
        ],
      ]),
    );
    await assert.rejects(
      prepareDocument(f.p, presentationPath, "deck.pptx", 10_000),
      /Office relationship target is missing/,
    );
    await writeFile(
      presentationPath,
      zip([
        ["ppt/presentation.xml", presentation],
        ["ppt/_rels/presentation.xml.rels", presentationRels],
        ["ppt/slides/slide1.xml", slide],
        [
          "ppt/_rels/unused.xml.RELS",
          Buffer.from(
            '<Relationships><Relationship Id="external" Target="https://example.invalid/unused" TargetMode="External"/></Relationships>',
          ),
        ],
      ]),
    );
    await assert.rejects(
      prepareDocument(f.p, presentationPath, "deck.pptx", 10_000),
      /External Office relationships are not permitted/,
    );
    await writeFile(
      presentationPath,
      zip([
        [
          "_rels/.rels",
          Buffer.from(
            '<Relationships><Relationship Id="root" Target="missing.xml"/></Relationships>',
          ),
        ],
        ["ppt/presentation.xml", presentation],
        ["ppt/_rels/presentation.xml.rels", presentationRels],
        ["ppt/slides/slide1.xml", slide],
      ]),
    );
    await assert.rejects(
      prepareDocument(f.p, presentationPath, "deck.pptx", 10_000),
      /Office relationship target is missing: missing\.xml/,
    );
    await writeFile(
      presentationPath,
      zip([
        ["ppt/presentation.xml", presentation],
        [
          "ppt/_rels/presentation.xml.rels",
          Buffer.from(
            '<Relationships><Relationship Id="s1" Target="%2e%2e%2f%2e%2e%2foutside.xml"/></Relationships>',
          ),
        ],
        ["ppt/slides/slide1.xml", slide],
      ]),
    );
    await assert.rejects(
      prepareDocument(f.p, presentationPath, "deck.pptx", 10_000),
      /Encoded Office relationship traversal/,
    );
  } finally {
    await f.cleanup();
  }
});

test("XLSX rejects invalid row coordinates, columns, shared strings and parts", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed())),
    path = join(f.root, "invalid.xlsx"),
    workbook = Buffer.from(
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" r:id="sheet1"/></sheets></workbook>',
    ),
    shared = Buffer.from("<sst><si><t>one</t></si></sst>");
  const pack = (relationship: string, sheet?: string): Buffer =>
    zip([
      ["xl/workbook.xml", workbook],
      ["xl/_rels/workbook.xml.rels", Buffer.from(relationship)],
      ...(sheet
        ? [["xl/worksheets/sheet1.xml", Buffer.from(sheet)] as [string, Buffer]]
        : []),
      ["xl/sharedStrings.xml", shared],
    ] as [string, Buffer][]);
  try {
    const invalidSheets = [
      {
        xml: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c></row></sheetData></worksheet>',
        error: "DOCUMENT_PARSE",
      },
      {
        xml: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v/></c></row></sheetData></worksheet>',
        error: "DOCUMENT_PARSE",
      },
      {
        xml: '<worksheet><sheetData><row r="1"><c r="IW1"><v>1</v></c></row></sheetData></worksheet>',
        error: "DOCUMENT_LIMIT",
      },
      {
        xml: '<worksheet><sheetData><row r="2"><c r="A2"><v>2</v></c></row><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
        error: "DOCUMENT_LIMIT",
      },
    ];
    for (const item of invalidSheets) {
      await writeFile(
        path,
        pack(
          '<Relationships><Relationship Id="sheet1" Target="worksheets/sheet1.xml"/></Relationships>',
          item.xml,
        ),
      );
      await assert.rejects(prepareDocument(f.p, path, "invalid.xlsx", 10_000), {
        code: item.error,
      });
    }
    const safeSheet =
      '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>';
    await assert.rejects(
      extractOffice(
        pack(
          '<Relationships><Relationship Id="sheet1" Target="worksheets/sheet1.xml"/></Relationships>',
          safeSheet,
        ),
        "xlsx",
        { sheet: "S", rows: "9007199254740992" },
        10_000,
      ),
      { code: "DOCUMENT_LIMIT" },
    );
    await writeFile(
      path,
      pack(
        '<Relationships><Relationship Id="sheet1" Target="worksheets/sheet1.xml"/></Relationships>',
        '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2101"/></sheetData></worksheet>',
      ),
    );
    const emptyTail = await prepareDocument(
      f.p,
      path,
      "invalid.xlsx::sheet=S",
      10_000,
    );
    assert.equal(emptyTail.reference.partial, true);
    assert.match(emptyTail.text, /PARTIAL: worksheet continues/);
    await writeFile(
      path,
      pack(
        "<Relationships/>",
        '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
      ),
    );
    await assert.rejects(
      prepareDocument(f.p, path, "invalid.xlsx", 10_000),
      /Missing worksheet relationship/,
    );
    await writeFile(
      path,
      pack(
        '<Relationships><Relationship Id="sheet1" Target="worksheets/missing.xml"/></Relationships>',
        "<worksheet><sheetData/></worksheet>",
      ),
    );
    await assert.rejects(
      prepareDocument(f.p, path, "invalid.xlsx", 10_000),
      /Office relationship target is missing/,
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
    await writeFile(
      join(f.p.attachments, `${prepared.reference.rawSha256}.raw`),
      "changed",
    );
    await assert.rejects(loadPreparedInput(f.p, prepared.reference), {
      code: "INPUT_SIZE",
    });
  } finally {
    await f.cleanup();
  }
});

test("Git attachments are bounded diffs and clipboard failure gives the file fallback", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const workspace = await gitWorkspace(f.root, {
      "README.md": "before\n",
      ":(glob)literal.txt": "original\n",
      "diagram.png": "image baseline\n",
    });
    await writeFile(join(workspace, "README.md"), "before\nafter\n");
    await writeFile(join(workspace, ":(glob)literal.txt"), "changed\n");
    await writeFile(
      join(workspace, "diagram.png"),
      Buffer.from([0, 1, 2, 0, 3]),
    );
    const diff = await prepareGitInput(
      f.p,
      workspace,
      "git:working",
      100_000,
      AbortSignal.timeout(5000),
    );
    assert.match(diff.text, /\+after/);
    assert.match(diff.text, /\+changed/);
    assert.match(diff.text, /-original/);
    assert.doesNotMatch(diff.text, /image baseline/);
    assert.doesNotMatch(diff.text, /GIT binary patch/);
    assert.match(diff.text, /PARTIAL: image paths omitted from Git diff/);
    assert.match(diff.text, /diagram\.png/);
    assert.equal(diff.reference.partial, true);
    assert.match(diff.reference.locator, /read-only Git working/);
    const imageRoot = join(f.root, "image-only-root");
    await mkdir(imageRoot);
    const imageOnly = await gitWorkspace(imageRoot, {
      "only.png": "image baseline\n",
    });
    await writeFile(join(imageOnly, "only.png"), "image changed\n");
    const imageDiff = await prepareGitInput(
      f.p,
      imageOnly,
      "git:working",
      100_000,
      AbortSignal.timeout(5000),
    );
    assert.match(imageDiff.text, /PARTIAL: image-only changes omitted/);
    assert.match(imageDiff.reference.locator, /only\.png/);
    assert.equal(imageDiff.reference.partial, true);
    const redactedContext = emptyConversationContext();
    redactedContext.redactedImageIds = [`img-${"c".repeat(64)}`];
    const beforeRejectedInputs = f.store.list().length;
    await assert.rejects(
      f.harness.create({
        kind: "chat",
        access: "read-only",
        objective: "inspect selected Git changes",
        preparedInputs: [imageDiff],
        contextState: redactedContext,
      }),
      { code: "GIT_REDACTED" },
    );
    await assert.rejects(
      f.harness.create({
        kind: "chat",
        access: "read-only",
        objective: "inspect Git status",
        workspace: imageOnly,
        inputs: ["git:status"],
        contextState: redactedContext,
      }),
      { code: "GIT_REDACTED" },
    );
    assert.equal(f.store.list().length, beforeRejectedInputs);
    assert.equal((f.harness.runtime as ScriptedRuntime).requests.length, 0);
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

test("Git input never executes repository filters or diff and fsmonitor helpers", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const workspace = await gitWorkspace(f.root, {
      ".gitattributes":
        "probe.txt filter=probe\n*.probe diff=probe\nREADME.md text\n",
      "README.md": "before\n",
      "probe.txt": "baseline\n",
      "helper.probe": "base\n",
      ":(glob)literal.txt": "literal before\n",
      "diagram.png": "image before\n",
      "delete-me.txt": "tracked before\n",
      "mode.txt": "same bytes\n",
    });
    const env = {
      ...cleanEnvironment,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const git = async (args: string[]) => {
      const result = await runProcess("git", args, {
        cwd: workspace,
        env,
        timeoutMs: 5000,
        maxBytes: 100_000,
      });
      assert.equal(result.code, 0, result.stderr);
      return result.stdout.trim();
    };
    const first = await git(["rev-parse", "HEAD"]);
    await writeFile(join(workspace, "README.md"), "before\ncommitted\n");
    const stage = await runProcess("git", ["add", "README.md"], {
      cwd: workspace,
      env,
      timeoutMs: 5000,
    });
    assert.equal(stage.code, 0, stage.stderr);
    const commit = await runProcess(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "second",
      ],
      { cwd: workspace, env, timeoutMs: 5000 },
    );
    assert.equal(commit.code, 0, commit.stderr);
    const second = await git(["rev-parse", "HEAD"]);
    await writeFile(
      join(workspace, "README.md"),
      "before\ncommitted\nworking\n",
    );
    await writeFile(join(workspace, ":(glob)literal.txt"), "literal after\n");
    await writeFile(
      join(workspace, "delete-me.txt"),
      "untracked secret content\n",
    );
    const removeFromIndex = await runProcess(
      "git",
      ["rm", "--cached", "--", "delete-me.txt"],
      { cwd: workspace, env, timeoutMs: 5000 },
    );
    assert.equal(removeFromIndex.code, 0, removeFromIndex.stderr);
    await chmod(join(workspace, "mode.txt"), 0o755);
    await writeFile(join(workspace, "staged.txt"), "staged version\n");
    const stageNew = await runProcess("git", ["add", "staged.txt"], {
      cwd: workspace,
      env,
      timeoutMs: 5000,
    });
    assert.equal(stageNew.code, 0, stageNew.stderr);
    await writeFile(join(workspace, "staged.txt"), "working version\n");
    const marker = join(f.root, "git-helper-marker");
    const helper = join(f.root, "git-helper.js");
    const helperSource = `const fs = require("node:fs");
const expectedParent = ${process.pid};
let pid = process.ppid;
for (let depth = 0; depth < 8 && pid > 1; depth++) {
  if (process.platform !== "linux" || pid === expectedParent) {
    fs.appendFileSync(${JSON.stringify(marker)}, String(process.argv[2]) + "\\n");
    break;
  }
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    break;
  }
}
`;
    await writeFile(helper, helperSource);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const invocation = `${quote(process.execPath)} ${quote(helper)}`;
    const helperInvocation = (name: string) => `${invocation} ${name}`;
    await appendFile(
      join(workspace, ".git", "config"),
      `\n[filter "probe"]\n\tclean = ${helperInvocation("clean")}\n\tprocess = ${helperInvocation("process")}\n\trequired = true\n[diff "probe"]\n\tcommand = ${helperInvocation("diff")}\n\ttextconv = ${helperInvocation("textconv")}\n[diff]\n\texternal = ${helperInvocation("external")}\n[core]\n\tfsmonitor = ${helperInvocation("fsmonitor")}\n`,
    );
    const assertNoHelper = async () => {
      const markers = await readFile(marker, "utf8").catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      });
      assert.equal(markers, "", `Git invoked configured helper: ${markers}`);
    };

    const working = await selectGitInput(
      workspace,
      "git:working",
      100_000,
      AbortSignal.timeout(10000),
    );
    assert.match(working.text, /\+working/);
    assert.match(working.text, /\+working version/);
    assert.match(working.text, /:\(glob\)literal\.txt/);
    assert.match(working.text, /staged\.txt/);
    assert.match(working.text, /deleted file mode 100644 "delete-me\.txt"/);
    assert.match(working.text, /mode 100644 => 100755 "mode\.txt"/);
    assert.doesNotMatch(working.text, /untracked secret content/);
    await assertNoHelper();
    const staged = await selectGitInput(
      workspace,
      "git:staged",
      100_000,
      AbortSignal.timeout(10000),
    );
    assert.match(staged.text, /\+staged version/);
    assert.doesNotMatch(staged.text, /\+working version/);
    assert.match(staged.text, /deleted file mode 100644 "delete-me\.txt"/);
    await assertNoHelper();
    const status = await selectGitInput(
      workspace,
      "git:status",
      100_000,
      AbortSignal.timeout(10000),
    );
    assert.match(status.text, /M "README\.md"/);
    assert.match(status.text, /AM "staged\.txt"/);
    await assertNoHelper();
    assert.match(
      await readGitStatus(workspace, AbortSignal.timeout(10000)),
      /recent commits:/,
    );
    await assertNoHelper();
    const singleCommit = await selectGitInput(
      workspace,
      `git:commit:${second}`,
      100_000,
      AbortSignal.timeout(10000),
    );
    assert.match(singleCommit.locator, /first parent/);
    assert.match(singleCommit.text, /\+committed/);
    await assertNoHelper();
    const range = await selectGitInput(
      workspace,
      `git:${first}..${second}`,
      100_000,
      AbortSignal.timeout(10000),
    );
    assert.match(range.text, /\+committed/);
    await assertNoHelper();

    const unbornRoot = join(f.root, "unborn");
    await mkdir(unbornRoot);
    const init = await runProcess("git", ["init", "-q"], {
      cwd: unbornRoot,
      env,
      timeoutMs: 5000,
    });
    assert.equal(init.code, 0, init.stderr);
    const unborn = await selectGitInput(
      unbornRoot,
      "git:working",
      100_000,
      AbortSignal.timeout(10000),
    );
    assert.match(unborn.locator, /unborn HEAD/);
    assert.match(unborn.text, /No text changes/);

    const nested = join(workspace, "nested");
    await mkdir(nested);
    await assert.rejects(
      selectGitInput(nested, "git:status", 100_000, AbortSignal.timeout(10000)),
      { code: "GIT_WORKSPACE" },
    );
    const guardedRoot = join(f.root, "guarded-worktree");
    await mkdir(guardedRoot);
    const guardedWorkspace = await gitWorkspace(guardedRoot, {
      "README.md": "guarded\n",
    });
    const conflictingWorktree = join(f.root, "conflicting-worktree");
    await mkdir(conflictingWorktree);
    await appendFile(
      join(guardedWorkspace, ".git", "config"),
      `\n[core]\n\tworktree = ${conflictingWorktree}\n`,
    );
    await assert.rejects(
      selectGitInput(
        guardedWorkspace,
        "git:status",
        100_000,
        AbortSignal.timeout(10000),
      ),
      { code: "GIT_WORKSPACE" },
    );

    const missingRoot = join(f.root, "missing-object");
    await mkdir(missingRoot);
    const missingWorkspace = await gitWorkspace(missingRoot, {
      "README.md": "present\n",
    });
    const missingCommit = await runProcess("git", ["rev-parse", "HEAD"], {
      cwd: missingWorkspace,
      env,
      timeoutMs: 5000,
    });
    const missingBlob = await runProcess(
      "git",
      ["rev-parse", "HEAD:README.md"],
      { cwd: missingWorkspace, env, timeoutMs: 5000 },
    );
    assert.equal(missingCommit.code, 0);
    assert.equal(missingBlob.code, 0);
    const objectId = missingBlob.stdout.trim();
    await rm(
      join(
        missingWorkspace,
        ".git",
        "objects",
        objectId.slice(0, 2),
        objectId.slice(2),
      ),
    );
    await assert.rejects(
      selectGitInput(
        missingWorkspace,
        `git:commit:${missingCommit.stdout.trim()}`,
        100_000,
        AbortSignal.timeout(10000),
      ),
      { code: "GIT_INPUT" },
    );
  } finally {
    await f.cleanup();
  }
});

test("Git comparisons omit tracked symlinks without hiding regular-file changes", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const workspace = await gitWorkspace(f.root, {
      "README.md": "initial regular content\n",
    });
    const env = {
      ...cleanEnvironment,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    await symlink(
      "PRIVATE_SYMLINK_TARGET_TOKEN",
      join(workspace, "tracked-link"),
    );
    await writeFile(
      join(workspace, "README.md"),
      "committed regular content\n",
    );
    const add = await runProcess(
      "git",
      ["add", "--", "README.md", "tracked-link"],
      { cwd: workspace, env },
    );
    assert.equal(add.code, 0, add.stderr);
    const commit = await runProcess(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "add tracked symlink",
      ],
      { cwd: workspace, env },
    );
    assert.equal(commit.code, 0, commit.stderr);
    const head = await runProcess("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      env,
    });
    assert.equal(head.code, 0, head.stderr);

    await writeFile(join(workspace, "README.md"), "staged regular change\n");
    const stage = await runProcess("git", ["add", "--", "README.md"], {
      cwd: workspace,
      env,
    });
    assert.equal(stage.code, 0, stage.stderr);
    await writeFile(join(workspace, "README.md"), "working regular change\n");

    const working = await selectGitInput(
      workspace,
      "git:working",
      100_000,
      AbortSignal.timeout(10_000),
    );
    const staged = await selectGitInput(
      workspace,
      "git:staged",
      100_000,
      AbortSignal.timeout(10_000),
    );
    const commitSelection = await selectGitInput(
      workspace,
      `git:commit:${head.stdout.trim()}`,
      100_000,
      AbortSignal.timeout(10_000),
    );

    for (const selection of [working, staged, commitSelection]) {
      assert.equal(selection.partial, true);
      assert.match(selection.text, /tracked-link/);
      assert.match(selection.text, /symbolic link/);
      assert.match(selection.text, /PARTIAL: content not inspected:/);
      assert.doesNotMatch(selection.text, /PRIVATE_SYMLINK_TARGET_TOKEN/);
    }
    assert.match(working.text, /\+working regular change/);
    assert.match(staged.text, /\+staged regular change/);
    assert.match(commitSelection.text, /\+committed regular content/);
  } finally {
    await f.cleanup();
  }
});

test("Git input keeps BOM-prefixed filenames distinct from ordinary names", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const normalName = "README.txt";
    const bomName = `\uFEFF${normalName}`;
    const workspace = await gitWorkspace(f.root, {
      [normalName]: "normal baseline\n",
      [bomName]: "BOM baseline\n",
    });
    await writeFile(join(workspace, normalName), "normal changed\n");
    await writeFile(join(workspace, bomName), "BOM changed\n");
    const selection = await selectGitInput(
      workspace,
      "git:working",
      100_000,
      AbortSignal.timeout(10_000),
    );
    const normalHeader = `modified ${JSON.stringify(normalName)}`;
    const bomHeader = `modified ${JSON.stringify(bomName)}`;
    const normalStart = selection.text.indexOf(normalHeader);
    const bomStart = selection.text.indexOf(bomHeader);
    assert.notEqual(normalStart, -1);
    assert.notEqual(bomStart, -1);
    const sectionEnd = (start: number) => {
      const next = selection.text.indexOf("\nmodified ", start + 1);
      return next < 0 ? selection.text.length : next;
    };
    const normalSection = selection.text.slice(
      normalStart,
      sectionEnd(normalStart),
    );
    const bomSection = selection.text.slice(bomStart, sectionEnd(bomStart));
    assert.match(normalSection, /\+normal changed/);
    assert.doesNotMatch(normalSection, /\+BOM changed/);
    assert.match(bomSection, /\+BOM changed/);
    assert.doesNotMatch(bomSection, /\+normal changed/);
  } finally {
    await f.cleanup();
  }
});

test("Git rejects disjoint-line diffs at the edit limit within a bounded time", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  try {
    const lineCount = 20_100;
    const before = Array.from(
      { length: lineCount },
      (_, index) => `before-${index}`,
    ).join("\n");
    const workspace = await gitWorkspace(f.root, {
      "large.txt": `${before}\n`,
    });
    const after = Array.from(
      { length: lineCount },
      (_, index) => `after-${index}`,
    ).join("\n");
    await writeFile(join(workspace, "large.txt"), `${after}\n`);
    const startedAt = Date.now();
    await assert.rejects(
      selectGitInput(
        workspace,
        "git:working",
        1_000_000,
        AbortSignal.timeout(10_000),
      ),
      { code: "GIT_LIMIT" },
    );
    assert.ok(Date.now() - startedAt < 3_000);
  } finally {
    await f.cleanup();
  }
});

test("PDF extraction fixes argv, maps page text, and marks omitted page images", async () => {
  const f = await fixture(new ScriptedRuntime(async () => completed()));
  const commands: string[][] = [];
  const png = await sharp({
    create: {
      width: 2,
      height: 1,
      channels: 3,
      background: { r: 20, g: 40, b: 60 },
    },
  })
    .png()
    .toBuffer();
  const sandbox = {
    executeArgs: async (
      workspace: string,
      args: string[],
      _signal: AbortSignal,
      readOnly = true,
    ) => {
      commands.push(args);
      assert.equal(readOnly, args[0] !== "/usr/bin/pdftoppm");
      if (args[0] === "/usr/bin/pdfinfo")
        return {
          code: 0,
          stdout: "Pages:          3\nEncrypted:      no\n",
          stderr: "",
          truncated: false,
        };
      if (args[0] === "/usr/bin/pdftotext")
        return {
          code: 0,
          stdout: "page two\fpage three\f",
          stderr: "",
          truncated: false,
        };
      await writeFile(join(workspace, "page-2.png"), png, { mode: 0o600 });
      return { code: 0, stdout: "", stderr: "", truncated: false };
    },
  } as unknown as Sandbox;
  try {
    const selected = await extractPdf(
      f.p,
      sandbox,
      Buffer.from("%PDF-fake"),
      "sample.pdf",
      { pages: "2-3", images: true },
      1200,
      "private",
      false,
      1,
      AbortSignal.timeout(5000),
    );
    assert.match(selected.text, /Page 2:\npage two/);
    assert.match(selected.text, /Page 3:\npage three/);
    assert.match(selected.text, /images for selected PDF pages 3-3/i);
    assert.equal(selected.locator, "pages 2-3; image pages 2-2");
    assert.equal(selected.images.length, 1);
    assert.deepEqual(commands[0], [
      "/usr/bin/pdfinfo",
      "/workspace/source.pdf",
    ]);
    assert.deepEqual(commands[1], [
      "/usr/bin/pdftotext",
      "-layout",
      "-f",
      "2",
      "-l",
      "3",
      "/workspace/source.pdf",
      "-",
    ]);
    assert.deepEqual(commands[2], [
      "/usr/bin/pdftoppm",
      "-f",
      "2",
      "-l",
      "2",
      "-singlefile",
      "-png",
      "-scale-to",
      "2048",
      "/workspace/source.pdf",
      "/workspace/page-2",
    ]);
    assert.ok(Buffer.byteLength(selected.text) <= 1200);
    commands.length = 0;
    const withoutImageCapacity = await extractPdf(
      f.p,
      sandbox,
      Buffer.from("%PDF-fake"),
      "sample.pdf",
      { pages: "2-3", images: true },
      1200,
      "private",
      false,
      0,
      AbortSignal.timeout(5000),
    );
    assert.equal(withoutImageCapacity.images.length, 0);
    assert.match(
      withoutImageCapacity.text,
      /images for selected PDF pages 2-3/i,
    );
    assert.match(withoutImageCapacity.locator, /image pages none/);
    assert.equal(commands.length, 2);
  } finally {
    await f.cleanup();
  }
});
