import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { AttachmentAutocompleteProvider } from "../src/tui/attachment-autocomplete.js";

test("attachment autocomplete falls back to safe workspace directory suggestions", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "attachment-autocomplete-"));
  try {
    await writeFile(join(workspace, "notes.md"), "");
    await writeFile(join(workspace, "my file.md"), "");
    await mkdir(join(workspace, "dir"));
    await writeFile(join(workspace, "dir", "a.txt"), "");
    await symlink(join(workspace, "dir"), join(workspace, "inside-link"));
    await mkdir(join(workspace, ".git"));
    await writeFile(join(workspace, ".env"), "");
    await writeFile(join(workspace, ".editorconfig"), "");
    const provider = new AttachmentAutocompleteProvider(
      new CombinedAutocompleteProvider(
        [{ name: "help", description: "Help" }],
        workspace,
        null,
      ),
      () => workspace,
    );
    const suggestions = async (text: string) =>
      provider.getSuggestions([text], 0, text.length, {
        signal: new AbortController().signal,
      });

    assert.deepEqual(
      (await suggestions("@no"))?.items.map((item) => item.value),
      ["@notes.md"],
    );
    assert.deepEqual(
      (await suggestions('@"my'))?.items.map((item) => item.value),
      ['@"my file.md"'],
    );
    assert.deepEqual(
      (await suggestions("@di"))?.items.map((item) => item.value),
      ["@dir/"],
    );
    assert.deepEqual(
      (await suggestions("@dir/a"))?.items.map((item) => item.value),
      ["@dir/a.txt"],
    );
    assert.equal(await suggestions("@../"), null);
    assert.equal(await suggestions("@dir/../no"), null);
    assert.equal(await suggestions("@/etc/"), null);
    assert.equal(await suggestions("@~/"), null);
    assert.equal(await suggestions("@inside-link/"), null);
    assert.equal(
      (await suggestions("@ins"))?.items.some(
        (item) => item.value === "@inside-link/",
      ) ?? false,
      false,
    );

    const dotFiles = (await suggestions("@."))?.items.map((item) => item.value);
    assert.ok(dotFiles?.includes("@.editorconfig"));
    assert.ok(!dotFiles?.includes("@.env"));
    assert.ok(!dotFiles?.includes("@.git/"));

    const command = await suggestions("/he");
    assert.deepEqual(
      command?.items.map((item) => item.value),
      ["help"],
    );
    assert.equal(command?.prefix, "/he");
    assert.deepEqual(
      provider.applyCompletion(
        ["/he"],
        0,
        3,
        command!.items[0]!,
        command!.prefix,
      ).lines,
      ["/help "],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
