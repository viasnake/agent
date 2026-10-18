import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readText } from "../src/util.js";

test("bounded text reads preserve UTF-8 and reject links, oversize and invalid bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-bounded-text-"));
  const path = join(root, "text.md");
  try {
    await writeFile(path, "日本語\n");
    assert.equal(await readText(path, 10), "日本語\n");
    await assert.rejects(readText(path, 9), { code: "INPUT_SIZE" });
    await assert.rejects(readText(root), { code: "INPUT_SIZE" });
    const symbolic = join(root, "symbolic.md");
    await symlink(path, symbolic);
    await assert.rejects(readText(symbolic), { code: "INPUT_SIZE" });
    const hard = join(root, "hard.md");
    await link(path, hard);
    await assert.rejects(readText(hard), { code: "INPUT_SIZE" });
    await rm(hard);
    await writeFile(path, Buffer.from([0xc3]));
    await assert.rejects(readText(path), { code: "BINARY_INPUT" });
    await writeFile(path, Buffer.from([0]));
    await assert.rejects(readText(path), { code: "BINARY_INPUT" });
    await writeFile(path, "");
    assert.equal(await readText(path), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
