import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { chromium } from "playwright";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { safeRelative, publicUrl, publicRepo } from "../security.js";
import { requestSchema } from "./protocol.js";
import type { WorkerRequest, WorkerResult } from "./protocol.js";

const text = z.string().max(2 * 1024 * 1024);
export type WorkerOptions = {
  root: string;
  production: boolean;
  browserExecutable?: string;
  fixtureOrigin?: string;
  popplerBin?: string;
};
export async function assertFileDescriptorPath(
  fd: number,
  expected: string,
): Promise<void> {
  // Validate the opened object itself: a checked parent can be replaced before open().
  if ((await realpath(`/proc/self/fd/${fd}`)) !== expected)
    throw new Error("File path changed during open");
}
export class Worker {
  private processes = new Set<number>();
  constructor(private options: WorkerOptions) {}
  private workspace(id: string): string {
    return join(this.options.root, "jobs", z.string().uuid().parse(id));
  }
  private async path(
    id: string,
    name: string,
    create = false,
  ): Promise<string> {
    const base = this.workspace(id),
      path = join(base, safeRelative(name));
    let current = base;
    if ((await realpath(base)) !== base)
      throw new Error("Workspace was replaced");
    for (const part of name.split("/").slice(0, -1)) {
      current = join(current, part);
      if (create)
        await mkdir(current).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Unsafe parent path");
    }
    return path;
  }
  async bytes(
    id: string,
    name: string,
    max = 50 * 1024 * 1024,
  ): Promise<Buffer> {
    const path = await this.path(id, name);
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      await assertFileDescriptorPath(handle.fd, path);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > max)
        throw new Error("Expected a bounded regular file");
      const bytes = Buffer.alloc(Number(info.size));
      let offset = 0;
      while (offset < bytes.length) {
        const part = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!part.bytesRead) break;
        offset += part.bytesRead;
      }
      const after = await handle.stat();
      if (
        offset !== bytes.length ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.ctimeMs !== info.ctimeMs
      )
        throw new Error("File changed while reading");
      return bytes;
    } finally {
      await handle.close();
    }
  }
  private async put(id: string, name: string, data: Uint8Array): Promise<void> {
    const path = await this.path(id, name, true);
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    try {
      await assertFileDescriptorPath(handle.fd, path);
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1)
        throw new Error("Expected a regular file");
      await handle.truncate(0);
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
  }
  private env(): NodeJS.ProcessEnv {
    return {
      PATH: "/opt/agent-node/bin:/usr/local/bin:/usr/bin:/bin",
      HOME: join(this.options.root, "home"),
      TMPDIR: join(this.options.root, "tmp"),
      LANG: "C.UTF-8",
      PLAYWRIGHT_BROWSERS_PATH:
        process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/agent-browsers",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
  }
  async process(
    command: string,
    args: string[],
    cwd: string,
    signal: AbortSignal,
    timeout = 300,
    maxBytes = 10485760,
  ): Promise<{ text: string; exitCode: number; truncated: boolean }> {
    if (signal.aborted) throw new Error("Aborted");
    const child = spawn(command, args, {
      cwd,
      env: this.env(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    if (child.pid) this.processes.add(child.pid);
    const chunks: Buffer[] = [];
    let size = 0,
      truncated = false,
      stopped = false;
    let force: NodeJS.Timeout | undefined;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
      }
      force = setTimeout(() => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
      }, 1000);
    };
    const timer = setTimeout(stop, timeout * 1000);
    const abortForce = stop;
    signal.addEventListener("abort", abortForce, { once: true });
    const accept = (chunk: Buffer) => {
      const remaining = maxBytes - size;
      if (remaining > 0) {
        const part = chunk.subarray(0, remaining);
        chunks.push(part);
        size += part.length;
      }
      if (chunk.length > remaining) {
        truncated = true;
        stop();
      }
    };
    child.stdout.on("data", accept);
    child.stderr.on("data", accept);
    let exitCleanup: NodeJS.Timeout | undefined;
    child.once("exit", () => {
      // An escaped grandchild can hold a pipe open after its shell exits. Bound that wait, then sweep the work UID.
      exitCleanup = setTimeout(() => {
        stopped = true;
        truncated = true;
        void this.cleanup().finally(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        });
      }, 250);
    });
    try {
      const exitCode = await new Promise<number>((resolveCode, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolveCode(code ?? 128));
      });
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      return {
        text: Buffer.concat(chunks).toString("utf8"),
        exitCode: stopped ? 124 : exitCode,
        truncated,
      };
    } finally {
      clearTimeout(timer);
      if (exitCleanup) clearTimeout(exitCleanup);
      if (force) clearTimeout(force);
      signal.removeEventListener("abort", abortForce);
      if (child.pid) this.processes.delete(child.pid);
    }
  }
  async cleanup(): Promise<boolean> {
    for (const pid of this.processes) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
    if (!this.options.production) return this.processes.size === 0;
    // A single work UID runs one job; sweep escaped process groups before admitting another job.
    for (let attempt = 0; attempt < 5; attempt++) {
      const pids: number[] = [];
      for (const name of await readdir("/proc")) {
        const pid = Number(name);
        if (!pid || pid === process.pid) continue;
        try {
          if ((await stat(`/proc/${name}`)).uid === process.getuid?.())
            pids.push(pid);
        } catch {}
      }
      if (!pids.length) return true;
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    return false;
  }
  async execute(
    request: WorkerRequest,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    const { jobId, op, args } = request;
    await mkdir(join(this.options.root, "home"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(join(this.options.root, "tmp"), {
      recursive: true,
      mode: 0o700,
    });
    const cwd = this.workspace(jobId);
    if (op === "health") return { uid: process.getuid?.() ?? -1 };
    if (op === "cleanup") return { cleanup: await this.cleanup() };
    if (op === "init") {
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      if ((await realpath(cwd)) !== cwd) throw new Error("Unsafe workspace");
      const repo = z.string().optional().parse(args.repoUrl);
      if (repo) {
        publicRepo(repo);
        const result = await this.process(
          "/usr/bin/git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "http.followRedirects=false",
            "clone",
            "--no-recurse-submodules",
            "--",
            repo,
            "project",
          ],
          cwd,
          signal,
        );
        if (result.exitCode) return result;
      } else {
        await mkdir(join(cwd, "project"), { recursive: true });
        const result = await this.process(
          "/usr/bin/git",
          ["init", "project"],
          cwd,
          signal,
        );
        if (result.exitCode) return result;
      }
      return { text: "Workspace ready. Project files are in project/." };
    }
    const name = () => safeRelative(z.string().parse(args.path));
    if (op === "read")
      return {
        text: (await this.bytes(jobId, name(), 2 * 1024 * 1024)).toString(
          "utf8",
        ),
      };
    if (op === "write") {
      await this.put(jobId, name(), Buffer.from(text.parse(args.text)));
      return { text: "Saved" };
    }
    if (op === "import") {
      const data = Buffer.from(
        z
          .string()
          .max(28 * 1024 * 1024)
          .parse(args.data),
        "base64",
      );
      if (data.length > 20 * 1024 * 1024) throw new Error("Upload too large");
      await this.put(jobId, name(), data);
      return { text: "Imported" };
    }
    if (op === "export")
      return { data: (await this.bytes(jobId, name())).toString("base64") };
    if (op === "shell") {
      const command = text.parse(args.command),
        timeout = z.number().int().min(1).max(3000).parse(args.timeout),
        maxBytes = z
          .number()
          .int()
          .min(1024)
          .max(100 * 1024 * 1024)
          .parse(args.maxBytes);
      const result = await this.process(
        "/bin/bash",
        ["-c", command],
        cwd,
        signal,
        timeout,
        maxBytes,
      );
      const cleanup = await this.cleanup();
      const log = `.agent-logs/${randomUUID()}.txt`;
      await this.put(jobId, log, Buffer.from(result.text));
      return { ...result, text: result.text.slice(-12000), log, cleanup };
    }
    if (op === "patch") {
      const result = await this.process(
        "/usr/bin/git",
        ["-C", "project", "add", "--all"],
        cwd,
        signal,
      );
      if (result.exitCode) return result;
      const head = await this.process(
        "/usr/bin/git",
        ["-C", "project", "rev-parse", "--verify", "HEAD"],
        cwd,
        signal,
      );
      const diff = await this.process(
        "/usr/bin/git",
        [
          "-C",
          "project",
          "diff",
          "--cached",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          ...(head.exitCode ? ["--root"] : ["HEAD"]),
        ],
        cwd,
        signal,
      );
      if (diff.exitCode) return diff;
      await this.put(jobId, "changes.patch", Buffer.from(diff.text));
      return {
        path: "changes.patch",
        text: diff.text.slice(0, 2000),
        exitCode: diff.exitCode,
      };
    }
    if (op === "source" || op === "browse")
      return this.browse(jobId, args, op === "source", signal);
    if (op === "render") return this.render(jobId, args, signal);
    throw new Error("Unsupported operation");
  }
  private url(value: string, preview: boolean): URL {
    const url = new URL(value);
    if (
      !this.options.production &&
      this.options.fixtureOrigin === url.origin &&
      !url.username &&
      !url.password
    )
      return url;
    return publicUrl(value, preview);
  }
  private async browse(
    id: string,
    args: Record<string, unknown>,
    source: boolean,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    const url = this.url(z.string().parse(args.url), !source);
    let previewPid: number | undefined;
    const previewCommand = z
      .string()
      .max(16000)
      .optional()
      .parse(args.previewCommand);
    if (previewCommand) {
      if (
        source ||
        !["127.0.0.1", "localhost"].includes(url.hostname) ||
        +url.port < 3000 ||
        +url.port > 3999
      )
        throw new Error("Preview must use a reserved loopback port");
      const child = spawn("/bin/bash", ["-c", previewCommand], {
        cwd: this.workspace(id),
        env: this.env(),
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => undefined);
      previewPid = child.pid;
      if (previewPid) this.processes.add(previewPid);
      for (let attempt = 0; attempt < 40; attempt++) {
        if (signal.aborted) break;
        try {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(200),
            redirect: "manual",
          });
          await response.body?.cancel();
          break;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
      }
    }
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: this.options.production,
      executablePath: this.options.browserExecutable,
      env: this.env(),
    });
    if (signal.aborted) {
      await browser.close();
      throw new Error("Aborted");
    }
    const abort = () => {
      void browser.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
        acceptDownloads: false,
      });
      await page.route("**/*", (route) => {
        try {
          this.url(route.request().url(), !source);
          void route.continue();
        } catch {
          void route.abort();
        }
      });
      const navigation = await page.goto(url.href, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      if (source && !navigation?.ok())
        throw new Error("Source HTTP response was not successful");
      if (!source) {
        const actions = z
          .array(
            z.object({
              type: z.enum(["click", "fill"]),
              selector: z.string().max(300),
              text: z.string().max(2000).optional(),
            }),
          )
          .max(10)
          .default([])
          .parse(args.actions);
        for (const action of actions) {
          if (signal.aborted) throw new Error("Aborted");
          if (action.type === "fill")
            await page.locator(action.selector).fill(action.text ?? "");
          else await page.locator(action.selector).click({ timeout: 10000 });
        }
      }
      const body = await page.locator("body").innerText({ timeout: 10000 });
      const path = `.agent-browser/${randomUUID()}.png`;
      await this.put(id, path, await page.screenshot({ fullPage: false }));
      return {
        text: body.slice(0, 64000),
        truncated: body.length > 64000,
        title: (await page.title()).slice(0, 1000),
        url: this.url(page.url(), !source).href,
        fetchedAt: new Date().toISOString(),
        path,
      };
    } finally {
      signal.removeEventListener("abort", abort);
      await browser.close();
      if (previewPid) {
        try {
          process.kill(-previewPid, "SIGKILL");
        } catch {}
        this.processes.delete(previewPid);
      }
      if (!(await this.cleanup()))
        throw new Error("Browser descendants were not reaped");
    }
  }
  private async render(
    id: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    const source = safeRelative(z.string().parse(args.source)),
      output = safeRelative(z.string().parse(args.output));
    const markdown = (await this.bytes(id, source, 2 * 1024 * 1024)).toString(
      "utf8",
    );
    const html = sanitizeHtml(await marked.parse(markdown), {
      allowedTags: [
        "p",
        "h1",
        "h2",
        "h3",
        "h4",
        "ul",
        "ol",
        "li",
        "pre",
        "code",
        "blockquote",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "strong",
        "em",
        "br",
        "hr",
        "a",
      ],
      allowedAttributes: {},
    });
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: this.options.production,
      executablePath: this.options.browserExecutable,
      env: this.env(),
    });
    if (signal.aborted) {
      await browser.close();
      throw new Error("Aborted");
    }
    const abort = () => {
      void browser.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const page = await browser.newPage({ javaScriptEnabled: false });
      await page.route("**/*", (route) => route.abort());
      await page.setContent(
        `<!doctype html><html lang="ja"><meta charset="utf-8"><style>@page{size:A4;margin:18mm}body{font:11pt "Noto Sans CJK JP",sans-serif;line-height:1.7;overflow-wrap:anywhere}h1,h2,h3{break-after:avoid}pre{white-space:pre-wrap}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:5px}img{max-width:100%}</style><body>${html}</body></html>`,
      );
      await page.evaluate(() => document.fonts.ready);
      await this.put(
        id,
        output,
        await page.pdf({
          format: "A4",
          printBackground: true,
          preferCSSPageSize: true,
        }),
      );
    } finally {
      signal.removeEventListener("abort", abort);
      await browser.close();
    }
    const cwd = this.workspace(id);
    const info = await this.process(
      join(this.options.popplerBin ?? "/usr/bin", "pdfinfo"),
      [output],
      cwd,
      signal,
    );
    if (info.exitCode)
      throw new Error("PDF inspection failed: Poppler is required");
    const pages = Number(info.text.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (!pages || pages > 30) throw new Error("PDF page limit exceeded");
    const extracted = await this.process(
      join(this.options.popplerBin ?? "/usr/bin", "pdftotext"),
      [output, "-"],
      cwd,
      signal,
    );
    if (extracted.exitCode || !extracted.text.trim())
      throw new Error("PDF is empty or text cannot be extracted");
    if (
      /[\u3040-\u30ff\u4e00-\u9fff]/.test(markdown) &&
      !/[\u3040-\u30ff\u4e00-\u9fff]/.test(extracted.text)
    )
      throw new Error("Japanese text is missing from PDF");
    const prefix = `.agent-render/${randomUUID()}`;
    await mkdir(dirname(await this.path(id, `${prefix}.png`, true)), {
      recursive: true,
    });
    const rendered = await this.process(
      join(this.options.popplerBin ?? "/usr/bin", "pdftoppm"),
      ["-scale-to", "1200", "-png", output, prefix],
      cwd,
      signal,
    );
    if (rendered.exitCode) throw new Error("PDF raster inspection failed");
    const screenshots = (await readdir(join(cwd, ".agent-render")))
      .filter(
        (name) =>
          name.startsWith(prefix.split("/")[1]!) && name.endsWith(".png"),
      )
      .sort()
      .map((name) => `.agent-render/${name}`);
    if (screenshots.length !== pages) throw new Error("Missing rendered pages");
    return {
      path: output,
      pages,
      screenshots,
      text: extracted.text.slice(0, 16000),
    };
  }
}

export async function serveWorker(options: WorkerOptions): Promise<void> {
  const worker = new Worker(options);
  let buffer = Buffer.alloc(0),
    active: { id: string; controller: AbortController } | undefined;
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 75 * 1024 * 1024) process.exit(65);
    let end: number;
    while ((end = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, end).toString("utf8");
      buffer = buffer.subarray(end + 1);
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        process.exit(65);
      }
      const cancel = z
        .object({ type: z.literal("cancel"), id: z.string() })
        .safeParse(value);
      if (cancel.success) {
        if (active?.id === cancel.data.id) active.controller.abort();
        continue;
      }
      const parsed = requestSchema.parse(value);
      if (active) process.exit(65);
      active = { id: parsed.id, controller: new AbortController() };
      void worker
        .execute(parsed, active.controller.signal)
        .then(
          (result) => {
            process.stdout.write(
              JSON.stringify({ id: parsed.id, ok: true, result }) + "\n",
            );
          },
          () => {
            process.stdout.write(
              JSON.stringify({
                id: parsed.id,
                ok: false,
                error:
                  "作業操作が失敗しました。入力・ログ・環境を確認してください",
              }) + "\n",
            );
          },
        )
        .finally(() => {
          active = undefined;
        });
    }
  });
  process.stdin.on("end", () => {
    active?.controller.abort();
    void worker.cleanup().finally(() => process.exit());
  });
}
