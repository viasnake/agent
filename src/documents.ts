import { lstat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parseDocument } from "yaml";
import type { Paths } from "./config.js";
import {
  AgentError,
  type DocumentReference,
  type PreparedInput,
} from "./types.js";
import {
  atomicWrite,
  privateDirectory,
  readBoundedFile,
  sha256,
} from "./util.js";
import { extractOffice } from "./office.js";
import type { Sandbox } from "./sandbox.js";
import { extractPdf } from "./pdf.js";
import type { DataClass, ImageReference } from "./types.js";
import { pinSharedBlobs } from "./shared-blobs.js";

export const maxDocumentBytes = 20_000_000;
export const maxZipEntries = 2_000;
export const maxZipEntryBytes = 8_000_000;
export const maxZipTotalBytes = 50_000_000;
export const maxDocumentPreviewBytes = 8_000;
export const maxPreparedDocuments = 8;
export const maxPreparedInputBytes = maxDocumentBytes;

const formats: Record<string, string> = {
  ".txt": "text",
  ".md": "markdown",
  ".markdown": "markdown",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".csv": "csv",
  ".tsv": "tsv",
  ".pdf": "pdf",
  ".docx": "docx",
  ".pptx": "pptx",
  ".xlsx": "xlsx",
};

export interface DocumentSelector {
  pages?: string;
  images?: boolean;
  sheet?: string;
  rows?: string;
  slides?: string;
  lines?: string;
  heading?: string;
}

export interface DocumentToken {
  path: string;
  selector: DocumentSelector;
}

export interface DocumentPreparationOptions {
  sandbox?: Sandbox;
  dataClass?: DataClass;
  localOnly?: boolean;
  expectedBytes?: number;
  remainingImages?: number;
  signal?: AbortSignal;
}

export function parseDocumentToken(token: string): DocumentToken {
  const [path, ...parts] = token.split("::");
  if (!path || path.includes("\0"))
    throw new AgentError("INPUT_SELECTOR", "Specify a valid attachment path.");
  const selector: DocumentSelector = {};
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator < 1)
      throw new AgentError("INPUT_SELECTOR", `Invalid selector: ${part}`);
    const key = part.slice(0, separator),
      value = part.slice(separator + 1);
    if (
      !value ||
      ![
        "pages",
        "images",
        "sheet",
        "rows",
        "slides",
        "lines",
        "heading",
      ].includes(key)
    )
      throw new AgentError(
        "INPUT_SELECTOR",
        `Unknown or empty selector: ${key}`,
      );
    if (key in selector)
      throw new AgentError("INPUT_SELECTOR", `Duplicate selector: ${key}`);
    if (key === "images") {
      if (value !== "yes" && value !== "no")
        throw new AgentError("INPUT_SELECTOR", "images must be yes or no");
      selector.images = value === "yes";
    } else Object.assign(selector, { [key]: value });
  }
  const format = formats[extname(path).toLowerCase()] ?? "text";
  const allowed: Record<string, string[]> = {
    pdf: ["pages", "images"],
    xlsx: ["sheet", "rows"],
    pptx: ["slides"],
    text: ["lines"],
    json: ["lines"],
    yaml: ["lines"],
    markdown: ["lines", "heading"],
    docx: ["lines"],
    csv: ["rows"],
    tsv: ["rows"],
  };
  for (const key of Object.keys(selector))
    if (!(allowed[format] ?? []).includes(key))
      throw new AgentError(
        "INPUT_SELECTOR",
        `Selector ${key} does not apply to ${format}`,
      );
  if (selector.heading && selector.lines)
    throw new AgentError(
      "INPUT_SELECTOR",
      "heading and lines selectors cannot be combined",
    );
  if (
    (selector.lines && !validRange(selector.lines)) ||
    (selector.rows && !validRange(selector.rows)) ||
    (selector.slides && !validRange(selector.slides)) ||
    (selector.pages && !validRange(selector.pages))
  )
    throw new AgentError(
      "INPUT_SELECTOR",
      "Ranges use positive integers such as 2-20",
    );
  return { path, selector };
}

function validRange(value: string): boolean {
  const match = /^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(value);
  if (!match) return false;
  const start = Number(match[1]),
    end = Number(match[2] ?? match[1]);
  return (
    Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end
  );
}

export async function prepareDocument(
  paths: Paths,
  sourcePath: string,
  token: string,
  maxExtractBytes: number,
  options: DocumentPreparationOptions = {},
): Promise<PreparedInput> {
  if (!Number.isSafeInteger(maxExtractBytes) || maxExtractBytes < 0)
    throw new AgentError("INPUT_SIZE", "Document input budget is invalid");
  const parsed = parseDocumentToken(token);
  const raw = await readBoundedFile(sourcePath, maxDocumentBytes, {
    expectedBytes: options.expectedBytes,
  });
  const rawSha256 = sha256(raw);
  const format = formats[extname(parsed.path).toLowerCase()] ?? "text";
  await privateDirectory(paths.attachments);
  let selected: {
    text: string;
    locator: string;
    partial: boolean;
    images?: ImageReference[];
  };
  if (["docx", "pptx", "xlsx"].includes(format)) {
    selected = await extractOffice(
      raw,
      format as "docx" | "pptx" | "xlsx",
      parsed.selector,
      maxExtractBytes,
    );
  } else if (format === "pdf") {
    if (!options.sandbox || !options.signal)
      throw new AgentError(
        "PDF_PREREQUISITE",
        "PDF selection requires sandboxed Poppler tools; configure Bubblewrap or a pinned rootless Podman image containing pdfinfo, pdftotext and pdftoppm.",
      );
    selected = await extractPdf(
      paths,
      options.sandbox,
      raw,
      parsed.path,
      parsed.selector,
      maxExtractBytes,
      options.dataClass ?? "private",
      options.localOnly ?? false,
      options.remainingImages ?? 0,
      options.signal,
    );
  } else
    selected = selectText(
      decodeText(raw),
      format,
      parsed.selector,
      maxExtractBytes,
    );
  await privateDirectory(paths.attachments);
  const blob = join(paths.attachments, `${rawSha256}.raw`);
  const id = `doc-${sha256(`${rawSha256}\0${parsed.path}\0${JSON.stringify(parsed.selector)}\0${sha256(selected.text)}`)}`;
  await pinSharedBlobs(paths, [
    `attachments/${rawSha256}.raw`,
    `attachments/${id}.selected`,
  ]);
  try {
    const existing = await lstat(blob);
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1 ||
      (existing.mode & 0o077) !== 0 ||
      existing.size !== raw.length
    )
      throw new AgentError(
        "UNSAFE_STORAGE",
        "Attachment blob is not a private regular file",
      );
    await readBoundedFile(blob, maxDocumentBytes, {
      expectedBytes: raw.length,
      expectedSha256: rawSha256,
      privateStorage: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWrite(blob, raw);
  }
  const reference: DocumentReference = {
    id,
    originalName: basename(parsed.path),
    format,
    selector: token.slice(parsed.path.length),
    rawSha256,
    selectedSha256: sha256(selected.text),
    rawBytes: raw.length,
    selectedBytes: Buffer.byteLength(selected.text),
    locator: selected.locator,
    partial: selected.partial,
    imageIds: selected.images?.map((image) => image.id),
  };
  for (const image of selected.images ?? []) image.documentId = reference.id;
  const selectedPath = join(paths.attachments, `${reference.id}.selected`);
  try {
    const existing = await lstat(selectedPath);
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.nlink !== 1 ||
      (existing.mode & 0o077) !== 0
    )
      throw new AgentError(
        "UNSAFE_STORAGE",
        "Prepared selection is not a private regular file",
      );
    await readBoundedFile(selectedPath, maxDocumentBytes, {
      expectedBytes: reference.selectedBytes,
      expectedSha256: reference.selectedSha256,
      privateStorage: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWrite(selectedPath, selected.text);
  }
  return { reference, text: selected.text, images: selected.images };
}

export async function storePreparedText(
  paths: Paths,
  name: string,
  format: string,
  selector: string,
  raw: Buffer,
  text: string,
  locator: string,
  partial: boolean,
): Promise<PreparedInput> {
  if (raw.length > maxDocumentBytes)
    throw new AgentError(
      "INPUT_SIZE",
      `Generated input exceeds ${maxDocumentBytes} bytes`,
    );
  if (Buffer.byteLength(text) > maxDocumentBytes)
    throw new AgentError(
      "INPUT_SIZE",
      `Generated selection exceeds ${maxDocumentBytes} bytes`,
    );
  const rawSha256 = sha256(raw),
    selectedSha256 = sha256(text),
    reference: DocumentReference = {
      id: `doc-${sha256(`${rawSha256}\0${name}\0${selector}\0${selectedSha256}`)}`,
      originalName: basename(name),
      format,
      selector,
      rawSha256,
      selectedSha256,
      rawBytes: raw.length,
      selectedBytes: Buffer.byteLength(text),
      locator,
      partial,
    };
  await privateDirectory(paths.attachments);
  const rawPath = join(paths.attachments, `${rawSha256}.raw`),
    selectedPath = join(paths.attachments, `${reference.id}.selected`);
  await pinSharedBlobs(paths, [
    `attachments/${rawSha256}.raw`,
    `attachments/${reference.id}.selected`,
  ]);
  for (const [path, bytes] of [
    [rawPath, raw],
    [selectedPath, Buffer.from(text)],
  ] as const) {
    try {
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid()) ||
        info.size !== bytes.length
      )
        throw new AgentError(
          "UNSAFE_STORAGE",
          "Prepared input storage is unsafe",
        );
      await readBoundedFile(path, maxDocumentBytes, {
        expectedBytes: bytes.length,
        expectedSha256: sha256(bytes),
        privateStorage: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWrite(path, bytes);
    }
  }
  return { reference, text };
}

export async function loadPreparedInput(
  paths: Paths,
  reference: DocumentReference,
): Promise<PreparedInput> {
  if (
    !/^doc-[a-f0-9]{64}$/.test(reference.id) ||
    !reference.originalName ||
    reference.originalName.length > 255 ||
    /[/\\\0]/.test(reference.originalName) ||
    ![
      "text",
      "markdown",
      "json",
      "yaml",
      "csv",
      "tsv",
      "pdf",
      "docx",
      "pptx",
      "xlsx",
      "git",
    ].includes(reference.format) ||
    typeof reference.selector !== "string" ||
    reference.selector.length > 2048 ||
    !/^[a-f0-9]{64}$/.test(reference.rawSha256) ||
    !/^[a-f0-9]{64}$/.test(reference.selectedSha256) ||
    !Number.isSafeInteger(reference.rawBytes) ||
    !Number.isSafeInteger(reference.selectedBytes) ||
    reference.rawBytes < 0 ||
    reference.rawBytes > maxDocumentBytes ||
    reference.selectedBytes < 0 ||
    reference.selectedBytes > maxDocumentBytes
  )
    throw new AgentError(
      "INPUT_INTEGRITY",
      "Invalid prepared attachment reference",
    );
  const rawPath = join(paths.attachments, `${reference.rawSha256}.raw`);
  const selectedPath = join(paths.attachments, `${reference.id}.selected`);
  await pinSharedBlobs(paths, [
    `attachments/${reference.rawSha256}.raw`,
    `attachments/${reference.id}.selected`,
  ]);
  await readBoundedFile(rawPath, maxDocumentBytes, {
    expectedBytes: reference.rawBytes,
    expectedSha256: reference.rawSha256,
    privateStorage: true,
  });
  const selectedBytes = await readBoundedFile(selectedPath, maxDocumentBytes, {
    expectedBytes: reference.selectedBytes,
    expectedSha256: reference.selectedSha256,
    privateStorage: true,
  });
  return {
    reference: structuredClone(reference),
    text: new TextDecoder("utf-8", { fatal: true }).decode(selectedBytes),
  };
}

function decodeText(raw: Buffer): string {
  if (
    raw.includes(0) ||
    raw.some(
      (byte) =>
        (byte < 0x20 && ![0x09, 0x0a, 0x0d].includes(byte)) || byte === 0x7f,
    )
  )
    throw new AgentError("BINARY_INPUT", "Binary documents are not supported");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new AgentError("BINARY_INPUT", "Document must be valid UTF-8");
  }
}

function validateHierarchy(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 512_000 || item.depth > 64)
      throw new AgentError(
        "DOCUMENT_LIMIT",
        "Structured document exceeds the nesting or cell limit",
      );
    if (Array.isArray(item.value)) {
      if (item.value.length > 2000)
        throw new AgentError(
          "DOCUMENT_LIMIT",
          "Structured arrays are limited to 2000 items",
        );
      for (const child of item.value)
        pending.push({ value: child, depth: item.depth + 1 });
    } else if (item.value && typeof item.value === "object") {
      const entries = Object.values(item.value);
      if (entries.length > 256)
        throw new AgentError(
          "DOCUMENT_LIMIT",
          "Structured objects are limited to 256 fields",
        );
      for (const child of entries)
        pending.push({ value: child, depth: item.depth + 1 });
    }
  }
}

function selectText(
  text: string,
  format: string,
  selector: DocumentSelector,
  maxBytes: number,
): { text: string; locator: string; partial: boolean } {
  let selected = text,
    locator = "whole document",
    partial = false;
  if (format === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AgentError("DOCUMENT_PARSE", "Malformed JSON document");
    }
    validateHierarchy(parsed);
  } else if (format === "yaml") {
    const document = parseDocument(text);
    if (document.errors.length)
      throw new AgentError("DOCUMENT_PARSE", "Malformed YAML");
    try {
      validateHierarchy(document.toJS({ maxAliasCount: 0 }));
    } catch {
      throw new AgentError("DOCUMENT_PARSE", "YAML aliases are not permitted");
    }
  }
  if (selector.lines) {
    const [start, end = start] = selector.lines.split("-").map(Number),
      lines = text.split("\n");
    if (end! > lines.length)
      throw new AgentError(
        "INPUT_SELECTOR",
        "Line range is outside the document",
      );
    selected = lines
      .slice(start! - 1, end)
      .map((line, i) => `${start! + i}: ${line}`)
      .join("\n");
    locator = `lines ${start}-${end}`;
    if (start! > lines.length)
      throw new AgentError(
        "INPUT_SELECTOR",
        "Line range is outside the document",
      );
  }
  if (selector.heading) {
    if (format !== "markdown")
      throw new AgentError(
        "INPUT_SELECTOR",
        "heading applies only to Markdown",
      );
    const lines = text.split("\n"),
      heading = selector.heading.toLowerCase();
    const start = lines.findIndex(
      (line) =>
        /^#{1,6}\s+/.test(line) &&
        line
          .replace(/^#{1,6}\s+/, "")
          .trim()
          .toLowerCase() === heading,
    );
    if (start < 0)
      throw new AgentError(
        "INPUT_SELECTOR",
        `Heading not found: ${selector.heading}`,
      );
    const level = /^#+/.exec(lines[start]!)![0]!.length;
    let end = start + 1;
    while (
      end < lines.length &&
      !new RegExp(`^#{1,${level}}\\s`).test(lines[end]!)
    )
      end++;
    selected = lines
      .slice(start, end)
      .map((line, i) => `${start + i + 1}: ${line}`)
      .join("\n");
    locator = `heading ${selector.heading} (lines ${start + 1}-${end})`;
  } else if (format === "csv" || format === "tsv") {
    const table = tableText(text, format === "tsv" ? "\t" : ",", selector.rows);
    selected = table.text;
    locator = table.locator;
    partial = table.partial;
  }
  const size = Buffer.byteLength(selected);
  if (size > maxBytes) {
    const marker =
      "\n[PARTIAL: selection exceeds the configured input limit; narrow the selection.]";
    if (maxBytes < Buffer.byteLength(marker))
      throw new AgentError(
        "INPUT_SIZE",
        "Narrow the document selection to fit the remaining input budget",
      );
    const excerpt = safeUtf8Prefix(
      selected,
      Math.min(
        maxDocumentPreviewBytes,
        Math.max(0, maxBytes - Buffer.byteLength(marker)),
      ),
    );
    return { text: `${excerpt}${marker}`, locator, partial: true };
  }
  return { text: selected, locator, partial };
}

function safeUtf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, maxBytes);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function tableText(
  text: string,
  delimiter: string,
  rowRange?: string,
): { text: string; locator: string; partial: boolean } {
  const match = rowRange && /^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(rowRange);
  if (rowRange && !match)
    throw new AgentError("INPUT_SELECTOR", "Invalid table row range");
  const start = match ? Number(match[1]) : 1,
    end = match ? Number(match[2] ?? match[1]) : 2000;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start)
    throw new AgentError("INPUT_SELECTOR", "Invalid table row range");
  if (end - start + 1 > 2000)
    throw new AgentError("DOCUMENT_LIMIT", "Select at most 2000 table rows");
  const parsed = parseTable(text, delimiter, start, end, !rowRange);
  if (rowRange && (!parsed.rows.length || end > parsed.rowCount))
    throw new AgentError(
      "INPUT_SELECTOR",
      "Table row range is outside the document",
    );
  const selected = parsed.rows.map(
    ({ number, cells }) => `${number}: ${JSON.stringify(cells)}`,
  );
  return {
    text:
      selected.join("\n") +
      (parsed.partial
        ? "\n[PARTIAL: table has more rows; select a narrower ::rows= range.]"
        : ""),
    locator: rowRange
      ? `rows ${start}-${parsed.rows.at(-1)?.number ?? end}`
      : `rows 1-${parsed.rows.at(-1)?.number ?? 0}`,
    partial: parsed.partial,
  };
}

function parseTable(
  text: string,
  delimiter: string,
  start: number,
  end: number,
  defaultWindow: boolean,
): {
  rows: Array<{ number: number; cells: string[] }>;
  partial: boolean;
  rowCount: number;
} {
  const rows: Array<{ number: number; cells: string[] }> = [],
    row: string[] = [];
  let cell = "",
    quoted = false,
    closedQuote = false,
    rowNumber = 0,
    partial = false;
  let rowCount = 0;
  let recordTouched = false;
  const finishRow = () => {
    rowNumber++;
    rowCount = rowNumber;
    if (rowNumber >= start && rowNumber <= end) {
      if (rows.length >= 2000)
        throw new AgentError(
          "DOCUMENT_LIMIT",
          "Select at most 2000 table rows",
        );
      rows.push({ number: rowNumber, cells: row.splice(0) });
    } else row.length = 0;
    if (defaultWindow && rowNumber > end) partial = true;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted && ch === '"') {
      if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
        closedQuote = true;
      }
    } else if (ch === '"' && !cell && !closedQuote) {
      quoted = true;
      recordTouched = true;
    } else if (!quoted && ch === delimiter) {
      recordTouched = true;
      if (row.length >= 256)
        throw new AgentError("DOCUMENT_LIMIT", "Table exceeds 256 columns");
      row.push(cell);
      cell = "";
      closedQuote = false;
    } else if (!quoted && (ch === "\n" || ch === "\r")) {
      if (row.length >= 256)
        throw new AgentError("DOCUMENT_LIMIT", "Table exceeds 256 columns");
      row.push(cell);
      cell = "";
      finishRow();
      closedQuote = false;
      recordTouched = false;
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else if (closedQuote) {
      throw new AgentError(
        "DOCUMENT_PARSE",
        "Unexpected character after quoted table cell",
      );
    } else if (ch === '"' && !quoted) {
      throw new AgentError("DOCUMENT_PARSE", "Malformed quoted table cell");
    } else {
      recordTouched = true;
      cell += ch;
    }
    if (cell.length > maxDocumentBytes)
      throw new AgentError(
        "DOCUMENT_LIMIT",
        "Table exceeds row, column, or cell limits",
      );
  }
  if (quoted)
    throw new AgentError("DOCUMENT_PARSE", "Malformed quoted table cell");
  if (recordTouched || row.length || cell.length) {
    if (row.length >= 256)
      throw new AgentError("DOCUMENT_LIMIT", "Table exceeds 256 columns");
    row.push(cell);
    finishRow();
  }
  return { rows, partial, rowCount };
}
