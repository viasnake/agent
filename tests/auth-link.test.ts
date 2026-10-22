import assert from "node:assert/strict";
import test from "node:test";
import {
  getOsc8LinkAtColumn,
  stripTerminalSequences,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { chatGPTLoginLink } from "../src/cli/auth-link.js";

const authorization = new URL("https://auth.openai.com/api/accounts/authorize");
authorization.search = new URLSearchParams({
  client_id: "dynamic_agent_client",
  agent_name_hint: "Local Agent",
  ext_agent_host_id: "urn:uuid:00000000-0000-4000-8000-000000000000",
  response_type: "code",
  redirect_uri: "http://127.0.0.1:1455/auth/callback",
  resource: "https://api.openai.com/v1",
  scope:
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  state: "s".repeat(43),
  code_challenge: "c".repeat(43),
  code_challenge_method: "S256",
  nonce: "n".repeat(43),
}).toString();

test("ChatGPT link keeps the full OAuth query through terminal wrapping", () => {
  const output = chatGPTLoginLink(authorization.href, true);
  const label = output.split("\n")[0]!;
  for (const width of [24, 40, 80]) {
    const rows = wrapTextWithAnsi(label, width);
    for (const row of rows)
      assert.equal(getOsc8LinkAtColumn(row, 0), authorization.href);
  }
  // Ignoring hyperlink escapes still leaves a complete, copyable fallback.
  const plain = stripTerminalSequences(output);
  assert.ok(plain.includes("Continue with ChatGPT"));
  assert.ok(plain.split("\n").includes(authorization.href));
});

test("redirected login output contains a plain URL without terminal escapes", () => {
  const output = chatGPTLoginLink(authorization.href, false);
  assert.equal(output.includes("\x1b"), false);
  assert.ok(output.split("\n").includes(authorization.href));
});

test("login links reject other destinations and terminal control injection", () => {
  for (const url of [
    "https://example.com/api/accounts/authorize",
    "http://auth.openai.com/api/accounts/authorize",
    "https://auth.openai.com/other",
    "https://user@auth.openai.com/api/accounts/authorize",
    authorization.href + "\x07",
    authorization.href + "\x1b]8;;https://example.com\x07",
  ])
    assert.throws(() => chatGPTLoginLink(url, true), { code: "AUTH" });
});
