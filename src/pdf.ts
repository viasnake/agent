import { lstat, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Paths } from "./config.js";
import { AgentError, type DataClass, type ImageReference } from "./types.js";
import { Sandbox } from "./sandbox.js";
import { atomicWrite, privateDirectory, readBoundedFile } from "./util.js";
import { maxConversationImages, saveImage } from "./images.js";

export interface PdfSelection {
  text: string;
  locator: string;
  partial: boolean;
  images: ImageReference[];
}

export async function extractPdf(
  paths: Paths,
  sandbox: Sandbox,
  raw: Buffer,
  name: string,
  selector: { pages?: string; images?: boolean },
  maxBytes: number,
  dataClass: DataClass,
  localOnly: boolean,
  remainingImages: number,
  signal: AbortSignal,
): Promise<PdfSelection> {
  await privateDirectory(paths.attachments);
  const scratch = await mkdtemp(join(paths.attachments, ".pdf-"));
  await privateDirectory(scratch);
  const pdfPath = join(scratch, "source.pdf");
  try {
    await atomicWrite(pdfPath, raw);
    const limit = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    const info = await sandbox.executeArgs(
      scratch,
      ["/usr/bin/pdfinfo", "/workspace/source.pdf"],
      limit,
      true,
      16000,
      30000,
    );
    if (info.code !== 0 || info.truncated)
      throw new AgentError(
        "PDF_INVALID",
        info.stderr.trim() ||
          "pdfinfo could not read this PDF; check that it is valid and not encrypted",
      );
    if (/^Encrypted:\s+yes/im.test(info.stdout))
      throw new AgentError(
        "PDF_ENCRYPTED",
        "Encrypted PDFs are not supported; provide an unencrypted copy",
      );
    const count = Number(/^Pages:\s+(\d+)\s*$/im.exec(info.stdout)?.[1]);
    if (!Number.isInteger(count) || count < 1 || count > 5000)
      throw new AgentError(
        "PDF_LIMIT",
        "PDF page count must be between 1 and 5000",
      );
    const [start, end] = selector.pages
      ? parsePageRange(selector.pages, count)
      : [1, Math.min(count, 20)];
    if (end - start + 1 > 20)
      throw new AgentError(
        "PDF_LIMIT",
        "Select at most 20 pages for PDF text extraction",
      );
    const textResult = await sandbox.executeArgs(
      scratch,
      [
        "/usr/bin/pdftotext",
        "-layout",
        "-f",
        String(start),
        "-l",
        String(end),
        "/workspace/source.pdf",
        "-",
      ],
      limit,
      true,
      maxBytes,
      30000,
    );
    if (textResult.code !== 0)
      throw new AgentError(
        "PDF_INVALID",
        textResult.stderr.trim() ||
          "pdftotext could not extract the selected PDF pages",
      );
    const truncatedPages = !selector.pages && end < count,
      extractedPages = textResult.stdout.split("\f").slice(0, end - start + 1);
    while (extractedPages.length < end - start + 1) extractedPages.push("");
    const pageText = extractedPages
      .map((page, index) => `Page ${start + index}:\n${page.trimEnd()}`)
      .join("\n\n");
    let text = pageText;
    const images: ImageReference[] = [];
    let partial = textResult.truncated || truncatedPages;
    const renderedPages: number[] = [];
    if (selector.images) {
      if (remainingImages < 0 || remainingImages > maxConversationImages)
        throw new AgentError(
          "IMAGE_LIMIT",
          "Invalid remaining PDF image capacity",
        );
      const renderEnd = Math.min(end, start + remainingImages - 1);
      if (renderEnd < start) partial = true;
      for (let page = start; page <= renderEnd; page++) {
        signal.throwIfAborted();
        const output = `page-${page}`;
        const rendered = await sandbox.executeArgs(
          scratch,
          [
            "/usr/bin/pdftoppm",
            "-f",
            String(page),
            "-l",
            String(page),
            "-singlefile",
            "-png",
            "-scale-to",
            "2048",
            "/workspace/source.pdf",
            `/workspace/${output}`,
          ],
          limit,
          false,
          16000,
          30000,
        );
        if (rendered.code !== 0)
          throw new AgentError(
            "PDF_RENDER",
            rendered.stderr.trim() || `Could not render PDF page ${page}`,
          );
        const imagePath = join(scratch, `${output}.png`),
          stat = await lstat(imagePath);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size > 5_000_000
        )
          throw new AgentError(
            "PDF_RENDER",
            `Rendered page ${page} is not a bounded regular image`,
          );
        const bytes = await readBoundedFile(imagePath, 5_000_000, {
          expectedBytes: stat.size,
        });
        images.push(
          await saveImage(
            paths,
            `${basename(name)}-page-${page}.png`,
            bytes,
            dataClass,
            localOnly,
          ),
        );
        renderedPages.push(page);
      }
      if (renderEnd < end) partial = true;
    }
    const textMarker =
      partial || Buffer.byteLength(pageText) > maxBytes
        ? "\n[PARTIAL: PDF text or page-image selection is incomplete; select narrower page ranges.]"
        : "";
    const omittedPages =
      selector.images && renderedPages.length < end - start + 1
        ? renderedPages.length
          ? `${renderedPages.at(-1)! + 1}-${end}`
          : `${start}-${end}`
        : "";
    const omittedImages = omittedPages
      ? `\n[PARTIAL: Images for selected PDF pages ${omittedPages} were omitted because the conversation image capacity was exhausted.]`
      : "";
    const markers = `${textMarker}${omittedImages}`;
    if (Buffer.byteLength(markers) > maxBytes)
      throw new AgentError(
        "INPUT_SIZE",
        "Narrow the PDF page selection to fit the remaining input budget",
      );
    const body = safeUtf8Prefix(
      pageText,
      Math.max(0, maxBytes - Buffer.byteLength(markers)),
    );
    if (Buffer.byteLength(body) < Buffer.byteLength(pageText)) partial = true;
    text = `${body}${markers}`;
    return {
      text,
      locator: `pages ${start}-${end}${selector.images ? `; image pages ${renderedPages.length ? `${renderedPages[0]}-${renderedPages.at(-1)}` : "none"}` : ""}`,
      partial,
      images,
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (error instanceof AgentError) throw error;
    throw new AgentError(
      "PDF_PREREQUISITE",
      `Sandboxed Poppler conversion is unavailable: ${error instanceof Error ? error.message : "unknown error"}. Install pdfinfo, pdftotext and pdftoppm or expose them to the Bubblewrap sandbox via execution.runtimePaths.`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function safeUtf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function parsePageRange(value: string, pageCount: number): [number, number] {
  const match = /^([1-9]\d*)(?:-([1-9]\d*))?$/.exec(value);
  if (!match)
    throw new AgentError(
      "INPUT_SELECTOR",
      "PDF page selection must use positive page numbers",
    );
  const start = Number(match[1]),
    end = Number(match[2] ?? match[1]);
  if (end < start || end > pageCount || end - start + 1 > 20)
    throw new AgentError("PDF_LIMIT", "Select at most 20 valid PDF pages");
  return [start, end];
}
