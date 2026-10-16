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
  attributes: Record<string, { local: string; value: string }>;
};

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
  parser.on("doctype", () => {
    throw new AgentError(
      "DOCUMENT_XML",
      "DTD and entity declarations are not permitted",
    );
  });
  parser.on("opentag", (tag) => onOpen(tag as Tag));
  parser.on("closetag", (tag) => onClose(tag as Tag));
  parser.on("text", onText);
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

function paragraphs(source: Buffer | undefined): string[] {
  const result: string[] = [];
  let active = false,
    text = "",
    style = "",
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
      if (active && tag.local === "pStyle") style = attr(tag, "val") ?? "";
    },
    (tag) => {
      if (tag.local === "p" && active) {
        const location = tableDepth
          ? `table row ${row} cell ${cell}`
          : "paragraph";
        const label = /^Heading/i.test(style) ? `heading ${style}` : location;
        result.push(`${label}: ${text.trim()}`);
        active = false;
      }
      if (tag.local === "tbl") tableDepth--;
    },
    (value) => {
      if (active) text += value;
    },
  );
  return result;
}

function relationships(source: Buffer | undefined): Map<string, string> {
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
        if (id && target) map.set(id, target);
      }
    },
    () => {},
    () => {},
  );
  return map;
}

function safeTarget(base: string, target: string): string {
  if (
    !target ||
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
  const excerpt = bytes.subarray(
    0,
    Math.max(0, Math.min(8000, maxBytes - Buffer.byteLength(marker))),
  );
  return {
    text: `${new TextDecoder().decode(excerpt)}${marker}`,
    partial: true,
  };
}

export async function extractOffice(
  raw: Buffer,
  format: "docx" | "pptx" | "xlsx",
  selector: { slides?: string; sheet?: string; rows?: string },
  maxBytes: number,
): Promise<{ text: string; locator: string; partial: boolean }> {
  const files = await unzip(raw);
  let result: string[],
    locator = "whole document";
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
          const id = attr(tag, "id");
          if (id) order.push(id);
        }
      },
      () => {},
      () => {},
    );
    const rels = relationships(files.get("ppt/_rels/presentation.xml.rels"));
    const selected: [number, number] = selector.slides
      ? parseRange(selector.slides, 50, "slides")
      : [1, Math.min(order.length, 50)];
    if (order.length > 50 && !selector.slides)
      throw new AgentError(
        "DOCUMENT_LIMIT",
        "PPTX has more than 50 slides; select slides explicitly",
      );
    const [start, end] = selected;
    result = [];
    for (let index = start; index <= end; index++) {
      const rel = rels.get(order[index - 1]!);
      if (!rel)
        throw new AgentError(
          "DOCUMENT_PARSE",
          `Missing slide relationship for slide ${index}`,
        );
      const path = safeTarget("ppt", rel);
      result.push(`slide ${index}: ${paragraphs(files.get(path)).join("\n")}`);
      const relsPath = `ppt/slides/_rels/${path.slice("ppt/slides/".length)}.rels`;
      const notesTarget = [...relationships(files.get(relsPath)).values()].find(
        (target) => target.includes("notesSlides/"),
      );
      if (notesTarget) {
        const notesPath = safeTarget("ppt/slides", notesTarget);
        if (files.has(notesPath))
          result.push(
            `slide ${index} notes: ${paragraphs(files.get(notesPath)).join("\n")}`,
          );
      }
    }
    locator = `slides ${start}-${end}`;
  } else {
    const workbook = files.get("xl/workbook.xml");
    if (!workbook)
      throw new AgentError("DOCUMENT_PARSE", "XLSX has no workbook");
    const shared = sharedStrings(files.get("xl/sharedStrings.xml"));
    const rels = relationships(files.get("xl/_rels/workbook.xml.rels"));
    const sheets: { name: string; rel: string }[] = [];
    parseXml(
      workbook,
      (tag) => {
        if (tag.local === "sheet") {
          const name = attr(tag, "name"),
            rel = attr(tag, "id");
          if (name && rel) sheets.push({ name, rel });
        }
      },
      () => {},
      () => {},
    );
    const sheet = sheets.find((item) => item.name === selector.sheet);
    if (!sheet)
      throw new AgentError(
        "INPUT_SELECTOR",
        selector.sheet
          ? `Sheet not found: ${selector.sheet}`
          : "Select a sheet with ::sheet=name",
      );
    const path = safeTarget("xl", rels.get(sheet.rel) ?? "");
    const sheetResult = parseSheet(files.get(path), shared, selector.rows);
    result = sheetResult.lines;
    if (sheetResult.partial)
      result.push(
        "[PARTIAL: worksheet continues beyond the 2000-row default; select a narrower range.]",
      );
    locator = `sheet ${sheet.name}${selector.rows ? ` rows ${selector.rows}` : ""}`;
  }
  const bounded = textBounded(result.join("\n"), maxBytes);
  return { text: bounded.text, locator, partial: bounded.partial };
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
  if (end < start || end - start + 1 > limit)
    throw new AgentError(
      "DOCUMENT_LIMIT",
      `${name} selection is limited to ${limit}`,
    );
  return [start, end];
}

function sharedStrings(source: Buffer | undefined): string[] {
  const result: string[] = [];
  let inItem = false,
    value = "";
  parseXml(
    source,
    (tag) => {
      if (tag.local === "si") {
        inItem = true;
        value = "";
      }
    },
    (tag) => {
      if (tag.local === "si" && inItem) {
        result.push(value);
        inItem = false;
      }
    },
    (text) => {
      if (inItem) value += text;
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
  const [start, end] = rows ? parseRange(rows, 2000, "rows") : [1, 2000];
  const output: string[] = [];
  let current:
    | {
        ref: string;
        type?: string;
        formula?: string;
        value?: string;
        inline?: string;
        field?: "formula" | "value" | "inline";
      }
    | undefined;
  let rowNumber = 0;
  let partial = false;
  parseXml(
    source,
    (tag) => {
      if (tag.local === "row") {
        rowNumber = Number(attr(tag, "r") ?? rowNumber + 1);
        if (rowNumber > 1_048_576)
          throw new AgentError("DOCUMENT_LIMIT", "Invalid worksheet row");
      }
      if (tag.local === "c")
        current = { ref: attr(tag, "r") ?? "", type: attr(tag, "t") };
      if (current && tag.local === "f") {
        current.formula = "";
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
    },
    (tag) => {
      if (tag.local === "f" || tag.local === "v" || tag.local === "is")
        if (current) current.field = undefined;
      if (tag.local === "c" && current) {
        const column = columnNumber(current.ref);
        if (column > 256)
          throw new AgentError(
            "DOCUMENT_LIMIT",
            "XLSX selection exceeds 256 columns",
          );
        if (rowNumber >= start && rowNumber <= end) {
          const value =
            current.type === "s"
              ? (shared[Number(current.value)] ?? "")
              : current.type === "inlineStr"
                ? (current.inline ?? "")
                : (current.value ?? "");
          output.push(
            `${current.ref}: ${current.formula ? `formula=${current.formula}; cached=` : ""}${JSON.stringify(value)}`,
          );
        }
        if (!rows && rowNumber > end) partial = true;
        current = undefined;
      }
    },
    (text) => {
      if (current?.field === "formula") current.formula += text;
      else if (current?.field === "inline") current.inline += text;
      else if (current?.field === "value") current.value += text;
    },
  );
  if (output.length > 2000 * 256)
    throw new AgentError("DOCUMENT_LIMIT", "XLSX selection exceeds 2000 rows");
  return { lines: output, partial };
}
