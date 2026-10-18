import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import ts from "typescript";
import type { CodeInfoInput } from "./code-info.js";

const input = workerData as CodeInfoInput;
const workspace = "/workspace/";
const library = "/__agent_lib__/";
const installedLibrary = dirname(
  createRequire(import.meta.url).resolve("typescript"),
);
const files = new Map(input.files.map((file) => [workspace + file.path, file]));
const libraries = new Map<string, string | undefined>();
let libraryBytes = 0;
function read(file: string): string | undefined {
  const captured = files.get(file);
  if (captured) return captured.text;
  if (!file.startsWith(library)) return;
  const name = file.slice(library.length);
  if (!/^lib\.[a-z0-9.-]+\.d\.ts$/.test(name)) return;
  if (!libraries.has(file)) {
    let text: string | undefined;
    try {
      text = readFileSync(join(installedLibrary, name), "utf8");
    } catch {
      text = undefined;
    }
    libraryBytes += Buffer.byteLength(text ?? "");
    if (libraries.size >= 200 || libraryBytes > 8_000_000)
      throw new Error("library limit");
    libraries.set(file, text);
  }
  return libraries.get(file);
}

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  allowJs: true,
  checkJs: true,
  noEmit: true,
  jsx: ts.JsxEmit.Preserve,
  types: [],
  skipLibCheck: true,
};
const directories = new Set<string>(["/workspace", "/__agent_lib__"]);
for (const file of files.keys()) {
  let directory = posix.dirname(file);
  while (directory !== "/") {
    directories.add(directory);
    directory = posix.dirname(directory);
  }
}
const host: ts.LanguageServiceHost = {
  getCompilationSettings: () => options,
  getScriptFileNames: () => [...files.keys()],
  getScriptVersion: () => "1",
  getScriptSnapshot: (file) => {
    const text = read(file);
    return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
  },
  getCurrentDirectory: () => "/workspace",
  getDefaultLibFileName: () => library + "lib.es2022.full.d.ts",
  fileExists: (file) => read(file) !== undefined,
  readFile: read,
  directoryExists: (directory) => directories.has(directory.replace(/\/$/, "")),
  getDirectories: (directory) =>
    [...directories]
      .filter((path) => posix.dirname(path) === directory)
      .map((path) => posix.basename(path)),
  realpath: (path) => path,
  useCaseSensitiveFileNames: () => true,
  getNewLine: () => "\n",
};

function analyze() {
  const service = ts.createLanguageService(host);
  try {
    const file = workspace + input.query.path;
    const program = service.getProgram()!;
    const source = program.getSourceFile(file)!;
    let position = 0;
    if (input.query.action !== "diagnostics") {
      const lines = source.getLineStarts();
      const start = lines[input.query.line - 1];
      const next = lines[input.query.line] ?? source.text.length;
      let end = next;
      while (end > (start ?? 0) && /[\r\n]/.test(source.text[end - 1]!)) end--;
      if (start === undefined || input.query.column - 1 > end - start)
        throw new Error("position");
      position = start + input.query.column - 1;
    }
    const results: Array<Record<string, unknown>> = [];
    let truncated = false,
      libraryMatches = 0,
      bytes = 0;
    function append(item: Record<string, unknown>) {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (results.length >= 100 || bytes + size > 32000) {
        truncated = true;
        return;
      }
      results.push(item);
      bytes += size;
    }
    function location(name: string, span: ts.TextSpan) {
      const captured = files.get(name);
      const source = program.getSourceFile(name);
      if (!captured || !source) {
        libraryMatches++;
        return;
      }
      const start = source.getLineAndCharacterOfPosition(span.start);
      const end = source.getLineAndCharacterOfPosition(
        span.start + span.length,
      );
      return {
        path: captured.path,
        sha256: captured.sha256,
        line: start.line + 1,
        column: start.character + 1,
        endLine: end.line + 1,
        endColumn: end.character + 1,
      };
    }
    if (input.query.action === "diagnostics") {
      for (const diagnostic of [
        ...service.getSyntacticDiagnostics(file),
        ...service.getSemanticDiagnostics(file),
      ]) {
        const at =
          diagnostic.file && diagnostic.start !== undefined
            ? location(diagnostic.file.fileName, {
                start: diagnostic.start,
                length: diagnostic.length ?? 0,
              })
            : undefined;
        append({
          ...at,
          code: diagnostic.code,
          category: ts.DiagnosticCategory[diagnostic.category].toLowerCase(),
          message: ts
            .flattenDiagnosticMessageText(diagnostic.messageText, "\n")
            .slice(0, 2000),
        });
      }
    } else if (input.query.action === "definition") {
      for (const definition of service.getDefinitionAtPosition(
        file,
        position,
      ) ?? []) {
        const at = location(definition.fileName, definition.textSpan);
        if (at)
          append({
            ...at,
            name: definition.name.slice(0, 200),
            kind: definition.kind,
          });
      }
    } else {
      for (const reference of service.getReferencesAtPosition(file, position) ??
        []) {
        const at = location(reference.fileName, reference.textSpan);
        if (at) append({ ...at, writeAccess: reference.isWriteAccess });
      }
    }
    return { compilerVersion: ts.version, results, truncated, libraryMatches };
  } finally {
    service.dispose();
  }
}
try {
  parentPort!.postMessage({ ok: true, result: analyze() });
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    error:
      error instanceof Error && error.message === "position"
        ? "position"
        : "unavailable",
  });
}
