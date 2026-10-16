import { Parser } from "htmlparser2";
import { AgentError } from "./types.js";
import type { PublicFetchResult } from "./network.js";

export const extractionVersion = "htmlparser2@10.0.0/text-v1";
const maxMetaBytes = 4096;
const maxDepth = 128;
const maxLinks = 200;
const maxLinkBytes = 2048;
const maxReportedDates = 50;
const blockTags = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);
const skippedTags = new Set(["nav", "script", "style", "template"]);
const preservedTags = new Set(["code", "pre"]);
const supportedCharsets = new Map([
  ["utf-8", "utf-8"],
  ["utf8", "utf-8"],
  ["us-ascii", "us-ascii"],
  ["windows-1252", "windows-1252"],
  ["iso-8859-1", "windows-1252"],
  ["shift_jis", "shift_jis"],
  ["shift-jis", "shift_jis"],
  ["euc-jp", "euc-jp"],
  ["iso-2022-jp", "iso-2022-jp"],
]);

export interface ExtractedSource {
  text: string;
  metadata: Record<string, unknown>;
}

function htmlCharset(body: Buffer): string | undefined {
  const prefix = body.subarray(0, maxMetaBytes).toString("latin1");
  const match =
    /<meta\b[^>]*(?:charset\s*=\s*["']?\s*|content\s*=\s*["'][^"']*\bcharset\s*=\s*)([A-Za-z0-9._-]+)/i.exec(
      prefix,
    );
  return match?.[1];
}

export function decodeResponse(
  response: PublicFetchResult,
  maxOutputBytes: number,
): ExtractedSource {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)
    throw new AgentError("SOURCE_SIZE", "Extracted source limit is invalid");
  const reportedCharset =
    response.charset ??
    (response.mediaType === "text/html" ||
    response.mediaType === "application/xhtml+xml"
      ? htmlCharset(response.body)
      : undefined) ??
    "utf-8";
  const charset = supportedCharsets.get(reportedCharset.toLowerCase());
  if (!charset)
    throw new AgentError(
      "SOURCE_ENCODING",
      `Unsupported source charset: ${reportedCharset}`,
    );
  let decoded: string;
  try {
    decoded = new TextDecoder(charset, {
      fatal: true,
      ignoreBOM: true,
    }).decode(response.body);
  } catch {
    throw new AgentError(
      "SOURCE_ENCODING",
      `Source bytes are not valid ${reportedCharset}`,
    );
  }
  const isHtml =
    response.mediaType === "text/html" ||
    response.mediaType === "application/xhtml+xml";
  if (!isHtml) {
    const marker = "\n[truncated: extracted text limit reached]";
    const truncated = Buffer.byteLength(decoded) > maxOutputBytes;
    const text = truncated
      ? `${clipUtf8(
          decoded,
          Math.max(0, maxOutputBytes - Buffer.byteLength(marker)),
        )}${clipUtf8(marker, maxOutputBytes)}`
      : decoded;
    return {
      text,
      metadata: {
        extractionVersion: "plain-text-v1",
        mediaType: response.mediaType,
        charset: reportedCharset,
        truncated,
        finalUrl: response.url,
        contentType: response.contentType,
        retrievedAt: response.retrievedAt,
        lastModified: response.lastModified
          ? { value: response.lastModified, origin: "http:last-modified" }
          : undefined,
      },
    };
  }
  return extractHtml(decoded, response, maxOutputBytes, reportedCharset);
}

function clipUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let length = maxBytes;
  while (
    length > 0 &&
    length < bytes.length &&
    (bytes[length]! & 0xc0) === 0x80
  )
    length--;
  return bytes.subarray(0, length).toString("utf8");
}

function extractHtml(
  html: string,
  response: PublicFetchResult,
  maxOutputBytes: number,
  charset: string,
): ExtractedSource {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)
    throw new AgentError("SOURCE_SIZE", "Extracted source limit is invalid");
  let text = "";
  let textBytes = 0;
  let truncated = false;
  const links: Array<{ url: string; text?: string }> = [];
  const reportedDates: Array<{ value: string; origin: string }> = [];
  const stack: Array<{
    name: string;
    skipped: boolean;
    link?: { url: string; text: string };
  }> = [];
  let overflowDepth = 0;
  let preservedDepth = 0;
  let parseError: Error | undefined;
  const append = (value: string) => {
    if (!value || truncated) return;
    const remaining = maxOutputBytes - textBytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const clipped = clipUtf8(value, remaining);
    text += clipped;
    textBytes += Buffer.byteLength(clipped);
    if (clipped.length !== value.length) truncated = true;
  };
  const newline = () => {
    if (text && !text.endsWith("\n")) append("\n");
  };
  const parser = new Parser(
    {
      onerror: (error) => {
        parseError = error;
      },
      onopentag: (name, attributes) => {
        const tag = name.toLowerCase();
        if (overflowDepth) {
          overflowDepth++;
          return;
        }
        if (stack.length >= maxDepth) {
          overflowDepth = 1;
          truncated = true;
          return;
        }
        const parentSkipped = stack.some((frame) => frame.skipped);
        const skipped = parentSkipped || skippedTags.has(tag);
        let link: { url: string; text: string } | undefined;
        if (!skipped && tag === "a" && links.length < maxLinks) {
          const href = attributes.href?.trim();
          if (href && Buffer.byteLength(href) <= maxLinkBytes) {
            try {
              const target = new URL(href, response.url);
              if (
                (target.protocol === "http:" || target.protocol === "https:") &&
                !target.username &&
                !target.password &&
                target.href.length <= maxLinkBytes
              ) {
                link = { url: target.href, text: "" };
                links.push(link);
              }
            } catch {
              // Invalid links are discovery metadata omissions, not fetch errors.
            }
          }
        }
        stack.push({ name: tag, skipped, link });
        if (skipped) return;
        if (tag === "meta") {
          const key = (
            attributes.name ??
            attributes.property ??
            attributes.itemprop ??
            ""
          ).toLowerCase();
          const value = attributes.content?.trim();
          if (
            value &&
            (/(?:publish|created|modified|updated|date)/i.test(key) ||
              key === "dc.date")
          ) {
            if (reportedDates.length < maxReportedDates)
              reportedDates.push({ value, origin: `html:meta:${key}` });
          }
        }
        if (tag === "time" && attributes.datetime?.trim()) {
          if (reportedDates.length < maxReportedDates)
            reportedDates.push({
              value: attributes.datetime.trim(),
              origin: "html:time:datetime",
            });
        }
        if (tag === "img" && attributes.alt?.trim()) {
          newline();
          append(`[untrusted alt text: ${attributes.alt.trim()}]`);
          newline();
        }
        if (blockTags.has(tag)) newline();
        if (preservedTags.has(tag)) preservedDepth++;
        if (tag === "td" || tag === "th") append(" | ");
      },
      ontext: (value) => {
        if (overflowDepth || stack.some((frame) => frame.skipped) || !value)
          return;
        const link = [...stack].reverse().find((frame) => frame.link)?.link;
        if (link) link.text = clipUtf8(link.text + value, 500);
        append(preservedDepth ? value : value.replace(/[\t\n\r\f ]+/g, " "));
      },
      onclosetag: (name) => {
        const tag = name.toLowerCase();
        if (overflowDepth) {
          overflowDepth--;
          return;
        }
        const index = stack.findLastIndex((frame) => frame.name === tag);
        if (index < 0) return;
        const frame = stack[index]!;
        stack.splice(index, 1);
        if (frame.skipped) return;
        if (preservedTags.has(tag))
          preservedDepth = Math.max(0, preservedDepth - 1);
        if (blockTags.has(tag)) newline();
      },
    },
    {
      decodeEntities: true,
      lowerCaseTags: true,
      lowerCaseAttributeNames: true,
      recognizeSelfClosing: true,
    },
  );
  parser.end(html);
  if (parseError)
    throw new AgentError("SOURCE_PARSE", "HTML source could not be parsed");
  const marker = "\n[truncated: extracted text limit reached]";
  const output = truncated
    ? `${clipUtf8(
        text,
        Math.max(0, maxOutputBytes - Buffer.byteLength(marker)),
      )}${clipUtf8(marker, maxOutputBytes)}`
    : text;
  return {
    text: output,
    metadata: {
      extractionVersion,
      mediaType: response.mediaType,
      charset,
      truncated,
      finalUrl: response.url,
      contentType: response.contentType,
      retrievedAt: response.retrievedAt,
      rawBytes: response.body.length,
      links,
      reportedDates,
      lastModified: response.lastModified
        ? { value: response.lastModified, origin: "http:last-modified" }
        : undefined,
    },
  };
}
