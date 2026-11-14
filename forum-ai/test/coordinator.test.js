import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runCoordinator } from "../src/coordinator.js";
import { REFUSAL } from "../src/quote-check.js";

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
  assert.equal(reply.answer, REFUSAL);
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
  assert.equal(bad.answer, REFUSAL);
  assert.deepEqual(bad.quotes, []);
});

test("refuse when no quote matches", async () => {
  const reply = await runCoordinator({
    comment: "enacted",
    urls: [],
    ask: async () => {
      throw new Error("should not be asked");
    },
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.answer, REFUSAL);
  assert.deepEqual(reply.quotes, []);
});
