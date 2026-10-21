import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { safePath } from "../util.js";
import { secretPath } from "../workspace.js";

const maxSuggestions = 50;

export class AttachmentAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters: string[] | undefined;

  constructor(
    private readonly delegate: AutocompleteProvider,
    private readonly workspace: () => string,
  ) {
    this.triggerCharacters = delegate.triggerCharacters;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const suggestions = await this.delegate.getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    );
    if (suggestions || options.signal.aborted) return suggestions;

    const text = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const prefix = this.attachmentPrefix(text);
    if (!prefix) return null;
    return this.getAttachmentSuggestions(prefix, options.signal);
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.delegate.applyCompletion(
      lines,
      cursorLine,
      cursorCol,
      item,
      prefix,
    );
  }

  shouldTriggerFileCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean {
    return (
      this.delegate.shouldTriggerFileCompletion?.(
        lines,
        cursorLine,
        cursorCol,
      ) ?? true
    );
  }

  private attachmentPrefix(text: string): string | null {
    const quotedStart = text.lastIndexOf('@"');
    if (quotedStart >= 0) {
      const quoteTail = text.slice(quotedStart + 2);
      if (
        (quoteTail.match(/"/g)?.length ?? 0) % 2 === 0 &&
        (quotedStart === 0 || /\s/.test(text[quotedStart - 1]!))
      )
        return text.slice(quotedStart);
    }
    const match = text.match(/(?:^|\s)(@[^\s]*)$/);
    return match?.[1] ?? null;
  }

  private async getAttachmentSuggestions(
    prefix: string,
    signal: AbortSignal,
  ): Promise<AutocompleteSuggestions | null> {
    const quoted = prefix.startsWith('@"');
    const rawPath = prefix.slice(quoted ? 2 : 1);
    if (
      rawPath.startsWith("~") ||
      isAbsolute(rawPath) ||
      rawPath.startsWith("\\") ||
      /^[a-zA-Z]:/.test(rawPath)
    )
      return null;

    const slash = rawPath.lastIndexOf("/");
    const directoryPrefix = slash >= 0 ? rawPath.slice(0, slash + 1) : "";
    const basenamePrefix = rawPath.slice(slash + 1);
    let directory: string;
    try {
      const workspace = this.workspace();
      if (directoryPrefix) {
        if (secretPath(directoryPrefix)) return null;
        directory = await safePath(workspace, directoryPrefix);
      } else {
        directory = await realpath(workspace);
      }
    } catch {
      return null;
    }
    if (signal.aborted) return null;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return null;
    }
    if (signal.aborted) return null;

    const matching = entries
      .filter(
        (entry) =>
          !entry.isSymbolicLink() &&
          (entry.isFile() || entry.isDirectory()) &&
          !entry.name.includes('"') &&
          !/[\u0000-\u001f\u007f]/.test(entry.name) &&
          !secretPath(`${directoryPrefix}${entry.name}`) &&
          entry.name.toLowerCase().startsWith(basenamePrefix.toLowerCase()),
      )
      .sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name),
      );
    const items: AutocompleteItem[] = [];
    for (const entry of matching) {
      if (items.length >= maxSuggestions) break;
      if (
        entry.isFile() &&
        !(await this.isAttachableFile(join(directory, entry.name)))
      )
        continue;
      const path = `${directoryPrefix}${entry.name}${entry.isDirectory() ? "/" : ""}`;
      const needsQuotes = quoted || /\s/.test(path);
      const value = needsQuotes ? `@"${path}"` : `@${path}`;
      items.push({
        value,
        label: `${entry.name}${entry.isDirectory() ? "/" : ""}`,
      });
    }
    return items.length ? { items, prefix } : null;
  }

  private async isAttachableFile(path: string): Promise<boolean> {
    try {
      const info = await lstat(path);
      return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
    } catch {
      return false;
    }
  }
}
