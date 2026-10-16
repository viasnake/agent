import { posix } from "node:path";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { SaxesParser } from "saxes";
import { AgentError } from "./types.js";
import {
  maxZipEntries,
  maxZipEntryBytes,
  maxZipTotalBytes,
} from "./documents.js";

type Tag = {
  local: string;
  attributes: Record<
    string,
    { local: string; prefix?: string; uri: string; value: string }
  >;
};
const relationshipNamespaces = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.fromBuffer(
      buffer,
      {
        lazyEntries: true,
        validateEntrySizes: true,
        decodeStrings: true,
        strictFileNames: true,
      },
      (error, zip) =>
        error || !zip
          ? reject(error ?? new Error("Invalid ZIP"))
          : resolve(zip),
    ),
  );
}

function entryName(entry: Entry): string {
  const name = entry.fileName;
  const segments = name.split("/");
  if (
    !name ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.includes(":") ||
    segments.some((part) => part === ".." || part === ".") ||
    yauzl.validateFileName(name) !== null ||
    ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000
  )
    throw new AgentError(
      "DOCUMENT_ARCHIVE",
      "Office archive contains an unsafe entry name",
    );
  if (entry.isEncrypted())
    throw new AgentError(
      "DOCUMENT_ARCHIVE",
      "Encrypted Office archives are not supported",
    );
  return name;
}

async function unzip(buffer: Buffer): Promise<Map<string, Buffer>> {
  const zip = await openZip(buffer);
  if (zip.entryCount > maxZipEntries) {
    zip.close();
    throw new AgentError(
      "DOCUMENT_ARCHIVE",
      `Office archives may contain at most ${maxZipEntries} entries`,
    );
  }
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Buffer>();
    let totalBytes = 0;
    const fail = (error: unknown) => {
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("entry", (entry: Entry) => {
      let name: string;
      try {
        name = entryName(entry);
        if (entries.has(name))
          throw new AgentError(
            "DOCUMENT_ARCHIVE",
            `Duplicate Office entry: ${name}`,
          );
        if (entry.uncompressedSize > maxZipEntryBytes)
          throw new AgentError(
            "DOCUMENT_ARCHIVE",
            `Office entry exceeds ${maxZipEntryBytes} bytes`,
          );
      } catch (error) {
        fail(error);
        return;
      }
      if (name.endsWith("/")) {
        entries.set(name, Buffer.alloc(0));
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream)
          return fail(error ?? new Error("Unable to read archive entry"));
        const chunks: Buffer[] = [];
        let bytes = 0;
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          totalBytes += chunk.length;
          if (bytes > maxZipEntryBytes || totalBytes > maxZipTotalBytes) {
            stream.destroy(
              new AgentError(
                "DOCUMENT_ARCHIVE",
                "Office decompressed byte limit exceeded",
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", fail);
        stream.on("end", () => {
          entries.set(name, Buffer.concat(chunks, bytes));
          zip.readEntry();
        });
      });
    });
    zip.on("end", () => resolve(entries));
    zip.readEntry();
  });
}

function parseXml(
  source: Buffer | undefined,
  onOpen: (tag: Tag) => void,
  onClose: (tag: Tag) => void,
  onText: (text: string) => void,
): void {
  if (!source) return;
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new AgentError("DOCUMENT_XML", "Office XML must be valid UTF-8");
  }
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0;
  parser.on("doctype", () => {
    throw new AgentError(
      "DOCUMENT_XML",
      "DTD and entity declarations are not permitted",
    );
  });
  parser.on("opentag", (tag) => {
    if (++depth > 100)
      throw new AgentError("DOCUMENT_XML", "Office XML nesting is too deep");
    onOpen(tag as Tag);
  });
  parser.on("closetag", (tag) => {
    onClose(tag as Tag);
    depth--;
  });
  parser.on("text", onText);
  parser.on("cdata", onText);
  parser.on("error", (error) => {
    throw new AgentError(
      "DOCUMENT_XML",
      `Malformed Office XML: ${error.message}`,
    );
  });
  parser.write(xml).close();
}

function attr(tag: Tag, local: string): string | undefined {
  return Object.values(tag.attributes).find((value) => value.local === local)
    ?.value;
}
function relAttr(tag: Tag): string | undefined {
  return Object.values(tag.attributes).find(
    (value) => value.local === "id" && relationshipNamespaces.has(value.uri),
  )?.value;
}

function paragraphs(source: Buffer | undefined): string[] {
  const result: string[] = [];
  let active = false,
    text = "",
    style = "",
    textDepth = 0,
    tableDepth = 0,
    row = 0,
    cell = 0;
  parseXml(
    source,
    (tag) => {
      if (tag.local === "tbl") tableDepth++;
      if (tag.local === "tr") {
        row++;
        cell = 0;
      }
      if (tag.local === "tc") cell++;
      if (tag.local === "p") {
        active = true;
        text = "";
        style = "";
      }
      if (active && tag.local === "t") textDepth++;
      if (active && tag.local === "pStyle") style = attr(tag, "val") ?? "";
      if (active && tag.local === "tab") text += "\t";
      if (active && ["br", "cr"].includes(tag.local)) text += "\n";
    },
    (tag) => {
      if (tag.local === "t" && active) textDepth--;
      if (tag.local === "p" && active) {
        const location = tableDepth
          ? `table row ${row} cell ${cell}`
          : "paragraph";
        const label = /^Heading/i.test(style) ? `heading ${style}` : location;
        result.push(`${label}: ${text}`);
        active = false;
      }
      if (tag.local === "tbl") tableDepth--;
    },
    (value) => {
      if (active && textDepth) text += value;
    },
  );
  return result;
}

function relationships(
  source: Buffer | undefined,
  base = "",
): Map<string, string> {
  const map = new Map<string, string>();
  parseXml(
    source,
    (tag) => {
      if (tag.local === "Relationship") {
        const id = attr(tag, "Id"),
          target = attr(tag, "Target");
        if (attr(tag, "TargetMode")?.toLowerCase() === "external")
          throw new AgentError(
            "DOCUMENT_ARCHIVE",
            "External Office relationships are not permitted",
          );
        if (
          target &&
          (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//"))
        )
          throw new AgentError(
            "DOCUMENT_ARCHIVE",
            "External Office relationships are not permitted",
          );
        if (!id || !target || map.has(id))
          throw new AgentError(
            "DOCUMENT_ARCHIVE",
            "Office relationship is missing identifiers or is duplicated",
          );
        safeTarget(base, target);
        map.set(id, target);
      }
    },
    () => {},
    () => {},
  );
  return map;
}

function relationshipBase(name: string): string {
  const marker = name.lastIndexOf("/_rels/");
  if (marker < 0) return "";
  const part = name.slice(marker + "/_rels/".length).replace(/\.rels$/, "");
  return posix.join(name.slice(0, marker), posix.dirname(part));
}

function safeTarget(base: string, target: string): string {
  if (
    !target ||
    target.startsWith("/") ||
    target.includes("\\") ||
    target.includes("\0") ||
    target.includes(":")
  )
    throw new AgentError(
      "DOCUMENT_ARCHIVE",
      "Office relationship target is unsafe",
    );
  const normalized = posix.normalize(posix.join(base, target));
  if (
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.startsWith("/")
  )
    throw new AgentError(
      "DOCUMENT_ARCHIVE",
      "Office relationship escapes the archive",
    );
  return normalized;
}

function textBounded(
  text: string,
  maxBytes: number,
): { text: string; partial: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return { text, partial: false };
  const marker =
    "\n[PARTIAL: extracted content exceeds the input limit; narrow the selection.]";
  if (maxBytes < Buffer.byteLength(marker))
    throw new AgentError(
      "INPUT_SIZE",
      "Narrow the Office selection to fit the remaining input budget",
    );
  const excerptEnd = Math.max(
    0,
    Math.min(8000, maxBytes - Buffer.byteLength(marker)),
  );
  let safeEnd = excerptEnd;
  while (safeEnd > 0 && (bytes[safeEnd]! & 0xc0) === 0x80) safeEnd--;
  const excerpt = bytes.subarray(0, safeEnd);
  return {
    text: `${new TextDecoder().decode(excerpt)}${marker}`,
    partial: true,
  };
}

export async function extractOffice(
  raw: Buffer,
  format: "docx" | "pptx" | "xlsx",
  selector: { slides?: string; sheet?: string; rows?: string; lines?: string },
  maxBytes: number,
): Promise<{ text: string; locator: string; partial: boolean }> {
  const files = await unzip(raw);
  for (const [name, source] of files) {
    if (/vbaProject|activeX|embeddings|oleObject|customUI/i.test(name))
      throw new AgentError(
        "DOCUMENT_ARCHIVE",
        "Office macros and embedded programs are not permitted",
      );
    if (name.endsWith(".xml") || name.endsWith(".rels")) {
      parseXml(
        source,
        (tag) => {
          if (
            (name === "[Content_Types].xml" || name.endsWith(".rels")) &&
            Object.values(tag.attributes).some((attribute) =>
              /macroEnabled|vbaProject|oleObject|activeX|embeddedPackage|embeddedObject/i.test(
                attribute.value,
              ),
            )
          )
            throw new AgentError(
              "DOCUMENT_ARCHIVE",
              "Office macros and embedded programs are not permitted",
            );
        },
        () => {},
        () => {},
      );
      if (name.endsWith(".rels")) relationships(source, relationshipBase(name));
    }
  }
  let result: string[],
    locator = "whole document",
    indexPartial = false;
  if (format === "docx") {
    const body = files.get("word/document.xml");
    if (!body)
      throw new AgentError("DOCUMENT_PARSE", "DOCX has no document body");
    result = paragraphs(body).map(
      (text, index) => `block ${index + 1}: ${text}`,
    );
  } else if (format === "pptx") {
    const presentation = files.get("ppt/presentation.xml");
    if (!presentation)
      throw new AgentError("DOCUMENT_PARSE", "PPTX has no presentation");
    const order: string[] = [];
    parseXml(
      presentation,
      (tag) => {
        if (tag.local === "sldId") {
          const id = relAttr(tag);
          if (!id)
            throw new AgentError(
              "DOCUMENT_PARSE",
              "Slide is missing its Office relationship id",
            );
          order.push(id);
        }
      },
      () => {},
      () => {},
    );
    const rels = relationships(
      files.get("ppt/_rels/presentation.xml.rels"),
      "ppt",
    );
    const slidePaths = order.map((id, index) => {
      const target = rels.get(id);
      if (!target)
        throw new AgentError(
          "DOCUMENT_PARSE",
          `Missing slide relationship for slide ${index + 1}`,
        );
      const path = safeTarget("ppt", target);
      if (!files.has(path))
        throw new AgentError("DOCUMENT_PARSE", `Missing slide part: ${path}`);
      return path;
    });
    if (order.length > 50 && !selector.slides) {
      result = [
        `Slide index: 1-${Math.min(50, order.length)} of ${order.length}. Select with ::slides=1-50.`,
        ...Array.from({ length: 50 }, (_, index) => `slide ${index + 1}`),
      ];
      locator = `slide index 1-50 of ${order.length}`;
      indexPartial = true;
    } else {
      const [start, end] = selector.slides
        ? parseRange(selector.slides, 50, "slides")
        : [1, order.length];
      if (end > order.length)
        throw new AgentError(
          "INPUT_SELECTOR",
          "Slide range is outside the presentation",
        );
      result = [];
      for (let index = start; index <= end; index++) {
        const path = slidePaths[index - 1]!;
        result.push(
          `slide ${index}: ${paragraphs(files.get(path)).join("\n")}`,
        );
        const relsPath = `ppt/slides/_rels/${path.slice("ppt/slides/".length)}.rels`;
        const notesTarget = [
          ...relationships(files.get(relsPath), "ppt/slides").values(),
        ].find((target) => target.includes("notesSlides/"));
        if (notesTarget) {
          const notesPath = safeTarget("ppt/slides", notesTarget);
          if (files.has(notesPath))
            result.push(
              `slide ${index} notes: ${paragraphs(files.get(notesPath)).join("\n")}`,
            );
        }
      }
      locator = `slides ${start}-${end}`;
    }
  } else {
    const workbook = files.get("xl/workbook.xml");
    if (!workbook)
      throw new AgentError("DOCUMENT_PARSE", "XLSX has no workbook");
    const shared = sharedStrings(files.get("xl/sharedStrings.xml"));
    const rels = relationships(files.get("xl/_rels/workbook.xml.rels"), "xl");
    const sheets: { name: string; rel: string }[] = [];
    parseXml(
      workbook,
      (tag) => {
        if (tag.local === "sheet") {
          const name = attr(tag, "name"),
            rel = relAttr(tag);
          if (!name || !rel || sheets.some((sheet) => sheet.name === name))
            throw new AgentError(
              "DOCUMENT_PARSE",
              "Worksheet is missing identifiers or has a duplicate name",
            );
          sheets.push({ name, rel });
        }
      },
      () => {},
      () => {},
    );
    for (const item of sheets) {
      const target = rels.get(item.rel);
      if (!target)
        throw new AgentError(
          "DOCUMENT_PARSE",
          `Missing worksheet relationship: ${item.name}`,
        );
      const path = safeTarget("xl", target);
      const sheetSource = files.get(path);
      if (!sheetSource)
        throw new AgentError(
          "DOCUMENT_PARSE",
          `Missing worksheet part: ${path}`,
        );
      parseSheet(sheetSource, shared);
    }
    if (!sheets.length)
      throw new AgentError("DOCUMENT_PARSE", "XLSX workbook has no worksheets");
    const sheet = sheets.find((item) => item.name === selector.sheet);
    if (!selector.sheet) {
      if (selector.rows)
        throw new AgentError(
          "INPUT_SELECTOR",
          "Select a workbook sheet before selecting rows",
        );
      result = [
        `Workbook sheet index (${sheets.length} sheets). Select with ::sheet=name::rows=1-2000.`,
        ...sheets
          .slice(0, 100)
          .map((item, index) => `sheet ${index + 1}: ${item.name}`),
      ];
      locator = `sheet index 1-${Math.min(sheets.length, 100)} of ${sheets.length}`;
      indexPartial = true;
    } else if (!sheet)
      throw new AgentError(
        "INPUT_SELECTOR",
        `Sheet not found: ${selector.sheet}`,
      );
    else {
      const path = safeTarget("xl", rels.get(sheet.rel) ?? "");
      const sheetResult = parseSheet(files.get(path), shared, selector.rows);
      result = sheetResult.lines;
      if (sheetResult.partial)
        result.push(
          "[PARTIAL: worksheet continues beyond the 2000-row default; select a narrower range.]",
        );
      locator = `sheet ${sheet.name}${selector.rows ? ` rows ${selector.rows}` : ""}`;
    }
  }
  if (format === "docx" && selector.lines) {
    const [start, end] = parseRange(selector.lines, 2000, "lines");
    const lines = result.join("\n").split("\n");
    if (end > lines.length)
      throw new AgentError(
        "INPUT_SELECTOR",
        "Line range is outside the document",
      );
    result = lines
      .slice(start - 1, end)
      .map((line, index) => `${start + index}: ${line}`);
    locator = `lines ${start}-${end}`;
  }
  const bounded = textBounded(
    result.join("\n"),
    indexPartial ? Math.min(maxBytes, 8_000) : maxBytes,
  );
  return {
    text: bounded.text,
    locator,
    partial:
      bounded.partial ||
      indexPartial ||
      result.some((line) => line.startsWith("[PARTIAL:")),
  };
}

function parseRange(
  value: string,
  limit: number,
  name: string,
): [number, number] {
  const match = /^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(value);
  if (!match) throw new AgentError("INPUT_SELECTOR", `Invalid ${name} range`);
  const start = Number(match[1]),
    end = Number(match[2] ?? match[1]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end < start ||
    end - start + 1 > limit
  )
    throw new AgentError(
      "DOCUMENT_LIMIT",
      `${name} selection is limited to ${limit}`,
    );
  return [start, end];
}

function sharedStrings(source: Buffer | undefined): string[] {
  const result: string[] = [];
  let inItem = false,
    textDepth = 0,
    value = "";
  parseXml(
    source,
    (tag) => {
      if (tag.local === "si") {
        inItem = true;
        value = "";
      }
      if (inItem && tag.local === "t") textDepth++;
    },
    (tag) => {
      if (tag.local === "t" && inItem) textDepth--;
      if (tag.local === "si" && inItem) {
        result.push(value);
        inItem = false;
      }
    },
    (text) => {
      if (inItem && textDepth) value += text;
    },
  );
  return result;
}

function columnNumber(cell: string): number {
  const letters = /^[A-Z]+/.exec(cell.toUpperCase())?.[0];
  if (!letters) return 0;
  return [...letters].reduce(
    (value, char) => value * 26 + char.charCodeAt(0) - 64,
    0,
  );
}

function parseSheet(
  source: Buffer | undefined,
  shared: string[],
  rows?: string,
): { lines: string[]; partial: boolean } {
  if (!source)
    throw new AgentError("DOCUMENT_PARSE", "Worksheet has no XML part");
  const [start, end] = rows ? parseRange(rows, 2000, "rows") : [1, 2000];
  const output: string[] = [];
  let current:
    | {
        ref: string;
        type?: string;
        formula?: string;
        hasFormula?: boolean;
        formulaType?: string;
        formulaSharedIndex?: string;
        value?: string;
        inline?: string;
        field?: "formula" | "value" | "inline";
      }
    | undefined;
  let rowNumber = 0;
  let maxRow = 0;
  let previousRow = 0;
  let inlineTextDepth = 0;
  const coordinates = new Set<string>();
  let partial = false;
  parseXml(
    source,
    (tag) => {
      if (tag.local === "row") {
        rowNumber = Number(attr(tag, "r") ?? rowNumber + 1);
        if (
          !Number.isInteger(rowNumber) ||
          rowNumber <= previousRow ||
          rowNumber > 1_048_576
        )
          throw new AgentError("DOCUMENT_LIMIT", "Invalid worksheet row");
        previousRow = rowNumber;
        maxRow = Math.max(maxRow, rowNumber);
      }
      if (tag.local === "c")
        current = { ref: attr(tag, "r") ?? "", type: attr(tag, "t") };
      if (current && tag.local === "f") {
        current.formula = "";
        current.hasFormula = true;
        current.formulaType = attr(tag, "t");
        current.formulaSharedIndex = attr(tag, "si");
        current.field = "formula";
      }
      if (current && tag.local === "v") {
        current.value = "";
        current.field = "value";
      }
      if (current && tag.local === "is") {
        current.inline = "";
        current.field = "inline";
      }
      if (current?.field === "inline" && tag.local === "t") inlineTextDepth++;
    },
    (tag) => {
      if (current?.field === "inline" && tag.local === "t") inlineTextDepth--;
      if (tag.local === "f" || tag.local === "v" || tag.local === "is")
        if (current) current.field = undefined;
      if (tag.local === "c" && current) {
        const column = columnNumber(current.ref);
        const cellRow = Number(/^[A-Z]+(\d+)$/.exec(current.ref)?.[1] ?? 0);
        if (
          !/^[A-Z]{1,3}\d+$/.test(current.ref) ||
          !Number.isInteger(cellRow) ||
          cellRow !== rowNumber ||
          column < 1 ||
          column > 256
        )
          throw new AgentError(
            "DOCUMENT_LIMIT",
            "XLSX selection exceeds 256 columns",
          );
        if (coordinates.has(current.ref))
          throw new AgentError(
            "DOCUMENT_PARSE",
            "Duplicate XLSX cell coordinate",
          );
        coordinates.add(current.ref);
        const value =
          current.type === "s"
            ? (() => {
                const lexical = current!.value ?? "";
                if (!/^(?:0|[1-9]\d*)$/.test(lexical))
                  throw new AgentError(
                    "DOCUMENT_PARSE",
                    "Invalid shared-string index",
                  );
                const index = Number(lexical);
                if (
                  !Number.isInteger(index) ||
                  index < 0 ||
                  index >= shared.length
                )
                  throw new AgentError(
                    "DOCUMENT_PARSE",
                    "Invalid shared-string index",
                  );
                return shared[index]!;
              })()
            : current.type === "inlineStr"
              ? (current.inline ?? "")
              : (current.value ?? "");
        if (rowNumber >= start && rowNumber <= end) {
          const formulaMetadata = [
            current.formulaType ? `type=${current.formulaType}` : "",
            current.formulaSharedIndex
              ? `sharedIndex=${current.formulaSharedIndex}`
              : "",
          ]
            .filter(Boolean)
            .join(", ");
          const formulaDetails = current.hasFormula
            ? ` formula${formulaMetadata ? `[${formulaMetadata}]` : ""}=${JSON.stringify(current.formula ?? "")}; cachedRaw=${JSON.stringify(current.value ?? "")};`
            : "";
          output.push(
            `${current.ref}: type=${current.type ?? "n"}${formulaDetails} raw=${JSON.stringify(current.type === "inlineStr" ? (current.inline ?? "") : (current.value ?? ""))} value=${JSON.stringify(value)}`,
          );
        }
        if (!rows && rowNumber > end) partial = true;
        current = undefined;
      }
    },
    (text) => {
      if (current?.field === "formula") current.formula += text;
      else if (current?.field === "inline" && inlineTextDepth)
        current.inline += text;
      else if (current?.field === "value") current.value += text;
    },
  );
  if (rows && end > maxRow)
    throw new AgentError(
      "INPUT_SELECTOR",
      "Worksheet row range is outside the sheet",
    );
  if (output.length > 2000 * 256)
    throw new AgentError("DOCUMENT_LIMIT", "XLSX selection exceeds 2000 rows");
  if (!rows && maxRow > end) partial = true;
  return { lines: output, partial };
}
