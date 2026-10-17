import test from "node:test";
import assert from "node:assert/strict";
import {
  requestToolApproval,
  type ToolApprovalRequest,
} from "../src/tool-approval.js";
import { confirmToolOperation } from "../src/tui/tool-approval.js";

const request: ToolApprovalRequest = {
  runId: "run",
  taskId: "task",
  operationId: "operation",
  server: "fixture",
  tool: "publish",
  effect: "publish",
  destination: "https://example.invalid/mcp",
  schemaSha256: "a".repeat(64),
  bindingSha256: "b".repeat(64),
  argumentsSha256: "c".repeat(64),
  argumentsJson: '{"text":"hello\\nworld"}',
  previousCompletions: 1,
};
test("external approval shows exact payload before cancel-first one-time confirmation", async () => {
  for (const stage of ["preview-cancel", "deny", "allow"]) {
    let shows = 0,
      choices = 0;
    const accepted = await confirmToolOperation(
      request,
      new AbortController().signal,
      {
        show: async (text) => {
          shows++;
          assert.match(text, /hello\\nworld/);
          assert.match(text, /https:\/\/example.invalid\/mcp/);
          assert.match(text, /重複操作/);
          return stage !== "preview-cancel";
        },
        choose: async (_title, options) => {
          choices++;
          assert.equal(options[0]!.value, "deny");
          return stage;
        },
      },
    );
    assert.equal(accepted, stage === "allow");
    assert.equal(shows, 1);
    assert.equal(choices, stage === "preview-cancel" ? 0 : 1);
  }
});
test("approval cancellation rejects late approval and unavailable handlers", async () => {
  const controller = new AbortController();
  let resolve!: (accepted: boolean) => void;
  let ready!: () => void;
  const started = new Promise<void>((r) => {
    ready = r;
  });
  const pending = requestToolApproval(
    async () => {
      ready();
      return new Promise<boolean>((r) => {
        resolve = r;
      });
    },
    request,
    controller.signal,
  );
  await started;
  controller.abort();
  assert.equal(await pending, false);
  resolve(true);
  await assert.rejects(
    () => requestToolApproval(undefined, request, new AbortController().signal),
    /no approval handler/,
  );
  await assert.rejects(
    () =>
      requestToolApproval(
        async () => {
          throw new Error("private handler error");
        },
        request,
        new AbortController().signal,
      ),
    /could not complete/,
  );
  let called = false;
  assert.equal(
    await confirmToolOperation(request, controller.signal, {
      show: async () => {
        called = true;
        return true;
      },
      choose: async () => {
        called = true;
        return "allow";
      },
    }),
    false,
  );
  assert.equal(called, false);
});
