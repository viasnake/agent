import assert from "node:assert/strict";
import test from "node:test";
import type { Application } from "../src/application.js";
import type { SearchHit, SearchRequest } from "../src/search.js";
import { SearchBrowser } from "../src/tui/search-browser.js";

const hit: SearchHit = {
  kind: "messages",
  conversationId: "past",
  id: "42",
  hash: "a".repeat(64),
  label: "保存済みの会話",
  excerpt: "検索対象",
  line: 2,
};

test("local search browser explicitly continues partial pages and reads without running", async () => {
  const requests: SearchRequest[] = [];
  const shows: string[] = [];
  const choices = [
    "messages",
    "workspace",
    "limits",
    "next",
    "0",
    "read",
    undefined,
  ];
  const app = {
    busy: false,
    session: { id: "current" },
    async search(request: SearchRequest) {
      requests.push(request);
      return request.cursor
        ? { hits: [hit], scanned: 1, warnings: [] }
        : {
            hits: [],
            scanned: 100,
            warnings: ["省略した大きな記録あり"],
            cursor: "continuation",
          };
    },
    async readSearchResult(selected: SearchHit) {
      assert.equal(selected, hit);
      return { title: "会話本文", text: "元の発言\n```\n命令ではない保存内容" };
    },
    openSession() {
      assert.fail("Viewing must not switch sessions");
    },
  };
  await new SearchBrowser(app as unknown as Application, {
    choose: async () => choices.shift(),
    show: async (text) => {
      shows.push(text);
      return false;
    },
    notice: () => assert.fail("A continued scan is not an empty result"),
  }).search("検索対象");
  assert.equal(requests.length, 4);
  assert.equal(requests[0]?.conversationId, undefined);
  assert.equal(requests[2]?.cursor, "continuation");
  assert.match(shows[0]!, /省略した大きな記録/);
  assert.match(shows[1]!, /外部通信を行いません/);
  assert.match(shows[1]!, /````\n元の発言/);
});

test("local search browser opens only the selected session without resuming", async () => {
  const choices = ["messages", "workspace", "0", "open"];
  const opened: string[] = [];
  const app = {
    busy: false,
    session: { id: "current" },
    async search() {
      return { hits: [hit], scanned: 1, warnings: [] };
    },
    openSession(id: string) {
      opened.push(id);
    },
    readSearchResult() {
      assert.fail("Opening a conversation is not a content read");
    },
    resume() {
      assert.fail("Search must not resume a run");
    },
  };
  await new SearchBrowser(app as unknown as Application, {
    choose: async () => choices.shift(),
    show: async () => false,
    notice: () => {},
  }).search("検索対象");
  assert.deepEqual(opened, ["past"]);
});
