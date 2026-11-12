import { workEnvironment } from "../work-credentials.js";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { OutputBuffer } from "@earendil-works/chord/output";
import { createModels } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type {
  ToolRegistration,
  ToolExecutionApi,
  ToolDiagnostic,
} from "@earendil-works/pi-durable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { safeRelative } from "../security.js";
import { PROTOCOL_BYTES, requestSchema } from "./protocol.js";
import type { WorkerRequest, WorkerResult, WorkFile } from "./protocol.js";

export type WorkerOptions = { root: string; production: boolean };
const fileLimit = 20 * 1024 * 1024;
const mcpServer = z
  .object({
    name: z.string().min(1).max(100),
    command: z.string().startsWith("/"),
    args: z.array(z.string()).max(100),
    env: z.record(z.string(), z.string()).default({}),
  })
  .strict();
export async function assertFileDescriptorPath(
  fd: number,
  expected: string,
): Promise<void> {
  if ((await realpath(`/proc/self/fd/${fd}`)) !== expected)
    throw new Error("File path changed during open");
}
export class Worker {
  private environments = new Set<NodeExecutionEnv>();
  constructor(private options: WorkerOptions) {}
  private workspace(id: string): string {
    return join(
      this.options.root,
      "conversations",
      z.string().uuid().parse(id),
    );
  }
  private env(): Record<string, string> {
    return {
      PATH: "/opt/agent-node/bin:/opt/agent-python/bin:/usr/local/bin:/usr/bin:/bin",
      HOME: join(this.options.root, "home"),
      TMPDIR: join(this.options.root, "tmp"),
      LANG: "C.UTF-8",
    };
  }
  private async path(
    id: string,
    name: string,
    create = false,
  ): Promise<string> {
    const base = this.workspace(id),
      path = join(base, safeRelative(name));
    if ((await realpath(base)) !== base)
      throw new Error("Workspace was replaced");
    let current = base;
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
  async bytes(id: string, name: string): Promise<Buffer> {
    const path = await this.path(id, name),
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    try {
      await assertFileDescriptorPath(handle.fd, path);
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > fileLimit)
        throw new Error("Expected a bounded regular file");
      const data = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < data.length) {
        const part = await handle.read(
          data,
          offset,
          data.length - offset,
          offset,
        );
        if (!part.bytesRead) break;
        offset += part.bytesRead;
      }
      const after = await handle.stat();
      if (
        offset !== data.length ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error("File changed while reading");
      return data;
    } finally {
      await handle.close();
    }
  }
  private async upload(id: string, name: string, data: Buffer): Promise<void> {
    if (data.length > fileLimit) throw new Error("File too large");
    const path = await this.path(id, name, true);
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    ).catch(async (error) => {
      if (error.code !== "EEXIST" || !(await this.bytes(id, name)).equals(data))
        throw error;
      return null;
    });
    if (!handle) return;
    try {
      await assertFileDescriptorPath(handle.fd, path);
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
  }
  private async list(id: string): Promise<WorkerResult> {
    const files: WorkFile[] = [];
    let scanned = 0,
      truncated = false;
    const walk = async (name: string, depth: number): Promise<void> => {
      if (depth > 10 || scanned >= 2000 || files.length >= 200) {
        truncated = true;
        return;
      }
      const path = await this.path(id, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      if (info.isFile()) {
        if (info.nlink === 1 && info.size <= fileLimit)
          files.push({ path: name, size: info.size });
        return;
      }
      if (!info.isDirectory()) return;
      // A replaced directory cannot expand the public download namespace.
      if ((await realpath(path)) !== path)
        throw new Error("Output directory changed");
      for (const item of await readdir(path)) {
        if (++scanned > 2000 || files.length >= 200) {
          truncated = true;
          break;
        }
        await walk(`${name}/${item}`, depth + 1).catch(() => {});
      }
    };
    for (const name of ["outputs", "attachments"])
      await walk(name, 0).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    return { files, truncated };
  }
  async cleanup(): Promise<boolean> {
    for (const env of this.environments) await env.cleanup(BACKGROUND_CONTEXT);
    if (!this.options.production) return this.environments.size === 0;
    // Only one conversation executes. End short-lived MCP connections before sweeping escaped work-UID processes.
    for (let attempt = 0; attempt < 10; attempt++) {
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
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }
  private async standardTool(
    id: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    const name = z.enum(["read", "write", "edit", "bash"]).parse(args.name),
      input = z.record(z.string(), z.unknown()).parse(args.args);
    const seconds = z.number().positive().max(300).parse(args.commandSeconds),
      maxBytes = z
        .number()
        .int()
        .positive()
        .max(10485760)
        .parse(args.commandBytes);
    const environment = {
      ...this.env(),
      ...workEnvironment.parse(args.environment ?? {}),
    };
    if (args.sshSocket !== undefined)
      environment.SSH_AUTH_SOCK = z
        .string()
        .regex(/^\/tmp\/agent-ssh-[A-Za-z0-9]+\/socket$/)
        .parse(args.sshSocket);
    const env = new NodeExecutionEnv({
      cwd: this.workspace(id),
      shellPath: "/bin/bash",
      shellEnv: environment,
    });
    this.environments.add(env);
    const context = withAbortSignal(
      AbortSignal.any([signal, AbortSignal.timeout(seconds * 1000)]),
      BACKGROUND_CONTEXT,
    );
    const output = new OutputBuffer({
        maxBytes: 51200,
        maxLines: 2000,
        retain: "tail",
      }),
      diagnostics: ToolDiagnostic[] = [];
    const exec = env.exec.bind(env);
    let bytes = 0;
    env.exec = (command, options, ctx) =>
      exec(
        command,
        {
          ...options,
          inheritEnv: false,
          env: { ...environment, ...options?.env },
          timeout: Math.min(options?.timeout ?? seconds, seconds),
          onOutput: (text, ctx, info) => {
            bytes += Buffer.byteLength(text);
            if (bytes > maxBytes)
              throw new Error("Command output limit reached");
            options?.onOutput?.(text, ctx, info);
          },
        },
        ctx,
      );
    // The four unmodified Pi tools use only this local API surface. No durable state or host capability crosses the UID.
    const local: Pick<
      ToolExecutionApi,
      | "env"
      | "agent"
      | "models"
      | "output"
      | "retainedOutput"
      | "diagnostic"
      | "outputWindow"
    > = {
      env,
      agent: async () => ({
        thinkingLevel: "off",
        extensions: [],
        tools: [],
        callable: [],
        deferred: [],
        sections: [],
      }),
      models: createModels(),
      output: (chunk) => {
        output.push(chunk);
      },
      outputWindow: undefined,
      retainedOutput: () => {
        const value = output.snapshot();
        return {
          text: value.text,
          truncated: value.droppedBytes > 0 || value.droppedLines > 0,
        };
      },
      diagnostic: (value) => diagnostics.push(value),
    };
    const api = new Proxy(local, {
      get: (target, key) => {
        if (key in target) return Reflect.get(target, key);
        throw new Error(`Unsupported standard-tool API: ${String(key)}`);
      },
    }) as ToolExecutionApi;
    try {
      const tool = (
        createCodingTools().tools as readonly ToolRegistration[]
      ).find((tool) => tool.name === name)!;
      const result = await tool.execute(input, api, context);
      output.end();
      return {
        result: {
          ...result,
          output: result.output ?? [
            { type: "text", text: output.snapshot().text },
          ],
          diagnostics: [...diagnostics, ...(result.diagnostics ?? [])],
        },
      };
    } catch (error) {
      output.end();
      return {
        result: {
          isError: true,
          output: [
            {
              type: "text",
              text: `${output.snapshot().text}\n${error instanceof Error ? error.message : "Tool failed"}`,
            },
          ],
          diagnostics,
        },
      };
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
      this.environments.delete(env);
      if (!(await this.cleanup()))
        throw new Error("Child cleanup was not confirmed");
    }
  }
  private async mcp(
    id: string,
    args: Record<string, unknown>,
    call: boolean,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    const server = mcpServer.parse(args.server),
      client = new Client({ name: "agent-work", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: { ...this.env(), ...server.env },
      stderr: "ignore",
      cwd: this.workspace(id),
      maxBufferSize: 1024 * 1024,
    });
    const seconds = z
      .number()
      .positive()
      .max(300)
      .parse(args.commandSeconds ?? 30);
    const stopped = () => {
      void client.close();
    };
    signal.addEventListener("abort", stopped, { once: true });
    const timer = setTimeout(stopped, seconds * 1000);
    try {
      if (signal.aborted) throw new Error("Interrupted");
      await client.connect(transport);
      if (!call) {
        const tools = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined);
          for (const tool of page.tools) {
            tools.push({
              name: tool.name,
              description: tool.description ?? tool.name,
              parameters: tool.inputSchema,
            });
            if (tools.length > 100) throw new Error("MCP tool limit exceeded");
          }
          cursor = page.nextCursor;
        } while (cursor);
        return { tools };
      }
      const result = await client.callTool(
        {
          name: z.string().parse(args.name),
          arguments: z.record(z.string(), z.unknown()).parse(args.args),
        },
        undefined,
        { signal, timeout: seconds * 1000 },
      );
      if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
        throw new Error("MCP result exceeds limit");
      return {
        result: {
          isError: !!result.isError,
          output: [{ type: "text", text: JSON.stringify(result) }],
        },
      };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stopped);
      await client.close();
      if (!(await this.cleanup()))
        throw new Error("MCP cleanup was not confirmed");
    }
  }
  async execute(
    request: WorkerRequest,
    signal: AbortSignal,
  ): Promise<WorkerResult> {
    const { conversationId: id, op, args } = request;
    if (op === "health") return { uid: process.getuid?.() ?? -1 };
    if (op === "delete_workspace") {
      const base = this.workspace(id);
      const parent = dirname(base);
      const info = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) return {};
      if (info.isSymbolicLink() || (await realpath(parent)) !== parent)
        throw new Error("Workspace parent was replaced");
      // rm unlinks a substituted session symlink; it never follows it into another session.
      await rm(base, { recursive: true, force: true });
      const directory = await open(parent, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return {};
    }
    for (const name of ["home", "tmp"])
      await mkdir(join(this.options.root, name), {
        recursive: true,
        mode: 0o700,
      });
    if (op === "cleanup") return { cleanup: await this.cleanup() };
    if (op === "mcp_list" || op === "mcp_call")
      return this.mcp(id, args, op === "mcp_call", signal);
    if (op === "init") {
      const base = this.workspace(id);
      await mkdir(base, { recursive: true, mode: 0o700 });
      if ((await realpath(base)) !== base) throw new Error("Unsafe workspace");
      for (const name of ["attachments", "outputs"]) {
        const path = await this.path(id, `${name}/.check`, true);
        if ((await realpath(dirname(path))) !== dirname(path))
          throw new Error("Unsafe workspace directory");
      }
      return {};
    }
    if (op === "tool") return this.standardTool(id, args, signal);
    if (op === "list") return this.list(id);
    const name = safeRelative(z.string().parse(args.path));
    if (op === "read_attachment") {
      if (!name.startsWith("attachments/")) throw new Error("Attachments only");
      return { data: (await this.bytes(id, name)).toString("base64") };
    }
    if (op === "download") {
      if (!name.startsWith("outputs/") && !name.startsWith("attachments/"))
        throw new Error("Only outputs and attachments are downloadable");
      try {
        return { data: (await this.bytes(id, name)).toString("base64") };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
      }
    }
    if (op === "upload") {
      if (!name.startsWith("attachments/")) throw new Error("Attachments only");
      await this.upload(
        id,
        name,
        Buffer.from(z.string().parse(args.data), "base64"),
      );
      return { path: name };
    }
    throw new Error("Unsupported operation");
  }
}
export async function serveWorker(options: WorkerOptions): Promise<void> {
  const worker = new Worker(options),
    controllers = new Map<string, AbortController>();
  let buffer = Buffer.alloc(0),
    activeTool = false;
  const reply = (value: unknown) => {
    const wire = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(wire) > PROTOCOL_BYTES) process.exit(1);
    process.stdout.write(wire);
  };
  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > PROTOCOL_BYTES) process.exit(1);
    let end: number;
    while ((end = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      try {
        const value = JSON.parse(line.toString("utf8"));
        if (value.type === "cancel") {
          controllers.get(z.string().uuid().parse(value.id))?.abort();
          continue;
        }
        const request = requestSchema.parse(value),
          controller = new AbortController();
        const tool = ["tool", "mcp_call", "mcp_list"].includes(request.op);
        if (tool && activeTool) {
          reply({ id: request.id, ok: false, error: "Worker busy" });
          continue;
        }
        if (tool) activeTool = true;
        controllers.set(request.id, controller);
        void worker
          .execute(request, controller.signal)
          .then(
            (result) => reply({ id: request.id, ok: true, result }),
            () =>
              reply({
                id: request.id,
                ok: false,
                error:
                  "Work operation failed; inspect the conversation and files before retrying",
              }),
          )
          .finally(() => {
            controllers.delete(request.id);
            if (tool) activeTool = false;
          });
      } catch {
        process.exit(1);
      }
    }
  });
  await new Promise<void>((resolve) => process.stdin.once("end", resolve));
  for (const controller of controllers.values()) controller.abort();
  await worker.cleanup();
  process.exit(0);
}
