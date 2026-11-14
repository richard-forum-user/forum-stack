import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runCoordinator } from "../src/coordinator.js";
import { SPOKEN_REFUSAL } from "../src/speak.js";

const page = "The bill was enacted by the legislature in public session.";
const second = "The act takes effect on the date the secretary certifies it.";

test("coordinator never fetches", () => {
  const src = readFileSync(new URL("../src/coordinator.js", import.meta.url), "utf8");
  const calls = src.replace(/async fetch\(request\)/g, "async handleRequest(request)");
  assert.doesNotMatch(calls, /(?<![\w.])fetch\s*\(/);
  assert.doesNotMatch(src, /read-page|readAllowlisted|globalThis\.fetch/);
});

test("worker entry only reaches the session object", () => {
  const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(src, /env\.SESSION/);
  assert.doesNotMatch(src, /env\.(COORDINATOR|GOV|ACADEMIA|PRESS)/);
});

test("source agents do not read the session or the cookie", () => {
  const src = readFileSync(new URL("../src/agents.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /SESSION|cookie|FORUM_AI_ADMIN/);
});

test("off-list host is not sent to an agent", async () => {
  const seen = [];
  const reply = await runCoordinator({
    comment: "Was the bill enacted?",
    urls: ["https://example.com/no", "https://www.maine.gov/bill"],
    ask: async (group, payload) => {
      seen.push({ group, urls: payload.urls });
      return { quotes: [], pages: {} };
    },
  });
  assert.deepEqual(seen, [{ group: "gov", urls: ["https://www.maine.gov/bill"] }]);
  assert.equal(reply.ok, false);
  assert.equal(reply.answer, SPOKEN_REFUSAL);
  assert.deepEqual(reply.quotes, []);
  assert.deepEqual(reply.refused, ["https://example.com/no"]);
});

test("routes each link to its own source group", async () => {
  const seen = [];
  await runCoordinator({
    comment: "sources",
    urls: [
      "https://pubmed.ncbi.nlm.nih.gov/1",
      "https://apnews.com/story",
      "https://www.maine.gov/bill",
    ],
    ask: async (group, payload) => {
      seen.push([group, payload.urls[0]]);
      return { quotes: [], pages: {} };
    },
  });
  assert.deepEqual(seen, [
    ["gov", "https://www.maine.gov/bill"],
    ["academia", "https://pubmed.ncbi.nlm.nih.gov/1"],
    ["press", "https://apnews.com/story"],
  ]);
});

test("joins exact quotes and drops a paraphrase", async () => {
  const good = await runCoordinator({
    comment: "enacted",
    urls: ["https://www.maine.gov/bill"],
    ask: async () => ({
      quotes: [
        { text: page, url: "https://www.maine.gov/bill" },
        { text: second, url: "https://www.maine.gov/bill" },
      ],
      pages: { "https://www.maine.gov/bill": `${page} ${second}` },
    }),
  });
  assert.equal(good.ok, true);
  assert.equal(good.answer, `"${page}" and "${second}"`);

  const bad = await runCoordinator({
    comment: "enacted",
    urls: ["https://www.maine.gov/bill"],
    ask: async () => ({
      quotes: [{ text: "The bill passed easily and everyone agreed.", url: "https://www.maine.gov/bill" }],
      pages: { "https://www.maine.gov/bill": page },
    }),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.answer, SPOKEN_REFUSAL);
  assert.deepEqual(bad.quotes, []);
});

test("a message with no link searches the allowlists before refusing", async () => {
  const seen = [];
  const reply = await runCoordinator({
    comment: "Tell me about Maine LD 307",
    urls: [],
    ask: async (group, payload) => {
      seen.push({ group, urls: payload.urls });
      return { quotes: [], pages: {} };
    },
  });
  assert.equal(seen[0].group, "gov");
  assert.equal(seen[0].urls[0], "https://legislature.maine.gov/legis/bills/display_ps.asp?LD=307&snum=132");
  assert.ok(seen[0].urls.includes("https://www.maine.gov/search?q=LD%20307"));
  assert.ok(seen.some((row) => row.group === "academia"));
  assert.ok(seen.some((row) => row.group === "press"));
  assert.equal(reply.ok, false);
  assert.equal(reply.answer, SPOKEN_REFUSAL);
  assert.equal(reply.lead, "");
});

test("hello with no link still searches, then refuses when nothing matches", async () => {
  const seen = [];
  const reply = await runCoordinator({
    comment: "Hello",
    urls: [],
    ask: async (group, payload) => {
      seen.push([group, payload.urls[0]]);
      return { quotes: [], pages: {} };
    },
  });
  assert.equal(seen[0][1], "https://www.maine.gov/search?q=Hello");
  assert.equal(reply.answer, "I looked at the allowlisted pages and did not find that.");
});

test("an empty comment is not searched", async () => {
  const reply = await runCoordinator({
    comment: "",
    urls: [],
    ask: async () => {
      throw new Error("should not be asked");
    },
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.answer, SPOKEN_REFUSAL);
});

test("a found quote is introduced with the host that was read", async () => {
  const quote = "An Act to Establish the Maine Data Center Coordination Council and Place a Temporary Limitation on Certain Data Centers";
  const reply = await runCoordinator({
    comment: "Tell me about Maine LD 307",
    urls: [],
    ask: async (group) => {
      if (group !== "gov") return { quotes: [], pages: {} };
      return {
        quotes: [{ text: quote, url: "https://legislature.maine.gov/legis/bills/display_ps.asp?LD=307&snum=132" }],
        pages: { "https://legislature.maine.gov/legis/bills/display_ps.asp?LD=307&snum=132": `LD # 307 ${quote} (TITLE CHANGE)` },
      };
    },
  });
  assert.equal(reply.ok, true);
  assert.equal(reply.lead, "Looking at legislature.maine.gov");
  assert.equal(reply.quotes[0].text, quote);
});
