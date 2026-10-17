import { strict as assert } from "node:assert";
import { test } from "node:test";
import { pinSharedBlobs, readSharedBlobPins } from "../src/shared-blobs.js";
import { fixture, ScriptedRuntime } from "./helpers.js";

test("shared blob pins persist for the process lifetime and reject unknown names", async () => {
  const f = await fixture(new ScriptedRuntime(async () => ""));
  try {
    const path = `images/${"b".repeat(64)}.img`;
    await pinSharedBlobs(f.p, [path]);
    const pins = await readSharedBlobPins(f.p);
    assert.equal(pins.length, 1);
    assert.deepEqual(pins[0]?.paths, [path]);
    await assert.rejects(
      pinSharedBlobs(f.p, ["../outside"]),
      (error: { code?: string }) => error.code === "UNSAFE_STORAGE",
    );
  } finally {
    await f.cleanup();
  }
});
