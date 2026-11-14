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

test("an LD bill keeps the current legislature page and drops search chrome", async () => {
  const title = "LD # 307 An Act to Establish the Maine Data Center Coordination Council and Place a Temporary Limitation on Certain Data Centers (TITLE CHANGE)";
  const bill = "https://legislature.maine.gov/legis/bills/display_ps.asp?LD=307&snum=132";
  const older = "https://legislature.maine.gov/legis/bills/display_ps.asp?LD=307&snum=131";
  const search = "https://pubmed.ncbi.nlm.nih.gov/?term=Tell%20me%20about%20Maine%20LD%20307";
  const reply = await runCoordinator({
    comment: "Tell me about Maine LD 307",
    urls: [bill],
    ask: async () => ({
      quotes: [
        { text: title, url: bill },
        { text: "An Act to Lower the State's Health Care Costs", url: older },
        { text: "Search terms: Tell me about Maine LD 307", url: search },
      ],
      pages: {
        [bill]: title,
        [older]: "An Act to Lower the State's Health Care Costs",
        [search]: "Search terms: Tell me about Maine LD 307",
      },
    }),
  });
  assert.equal(reply.ok, true);
  assert.equal(reply.lead, "Looking at legislature.maine.gov");
  assert.deepEqual(reply.quotes.map((quote) => quote.url), [bill]);
});

test("search-page chrome is not quoted, so a greeting still refuses", async () => {
  const search = "https://pubmed.ncbi.nlm.nih.gov/?term=Hello";
  const reply = await runCoordinator({
    comment: "Hello",
    urls: [search],
    ask: async () => ({
      quotes: [{ text: "Cite Item in Clipboard 2 Cite Hello", url: search }],
      pages: { [search]: "Cite Item in Clipboard 2 Cite Hello" },
    }),
  });
  assert.equal(reply.ok, false);
  assert.equal(reply.answer, "I looked at the allowlisted pages and did not find that.");
});

test("a detail question quotes the bill text and says when experts are absent", async () => {
  const comment = "Tell me about LD 307 in greater detail, what are experts saying?";
  const display = "https://legislature.maine.gov/legis/bills/display_ps.asp?LD=307&snum=132";
  const pdf = "https://legislature.maine.gov/legis/bills/getPDF.asp?paper=HP0207&item=2&snum=132";
  const search = "https://www.npr.org/search?query=LD%20307";
  const title = "LD # 307 An Act to Establish the Maine Data Center Coordination Council and Place a Temporary Limitation on Certain Data Centers (TITLE CHANGE)";
  const section = "Sec. 1. Temporary limitation on certain data centers. Notwithstanding any provision of law to the contrary, prior to November 1, 2027, a municipality may not issue a permit.";
  const reply = await runCoordinator({
    comment,
    urls: [display, pdf, search],
    ask: async () => ({
      quotes: [
        { text: title, url: display },
        { text: section, url: pdf },
        { text: "Search terms: Tell me about LD 307 in greater detail", url: search },
      ],
      pages: {
        [display]: title,
        [pdf]: section,
        [search]: "Search terms: Tell me about LD 307 in greater detail",
      },
    }),
  });
  assert.equal(reply.ok, true);
  assert.ok(reply.quotes.length >= 2);
  assert.ok(reply.quotes.some((quote) => quote.url === pdf && quote.text === section));
  assert.equal(reply.quotes.some((quote) => quote.url === search), false);
  assert.match(reply.lead, /^Looking at legislature\.maine\.gov/);
  assert.match(reply.lead, /Expert commentary was not on an allowlisted page\.$/);
});

test("expert commentary on an allowlisted page is quoted and named", async () => {
  const comment = "What are experts saying about LD 307?";
  const pdf = "https://legislature.maine.gov/legis/bills/getPDF.asp?paper=HP0207&item=2&snum=132";
  const story = "https://www.npr.org/2026/maine-ld-307";
  const section = "Sec. 1. Temporary limitation on certain data centers. Notwithstanding any provision of law to the contrary, prior to November 1, 2027, a municipality may not issue a permit.";
  const said = "Experts told the committee the data center limit in LD 307 is temporary.";
  const reply = await runCoordinator({
    comment,
    urls: [pdf, story],
    ask: async () => ({
      quotes: [
        { text: section, url: pdf },
        { text: said, url: story },
      ],
      pages: { [pdf]: section, [story]: said },
    }),
  });
  assert.equal(reply.ok, true);
  assert.ok(reply.quotes.some((quote) => quote.url === story));
  assert.equal(reply.lead, "Looking at legislature.maine.gov and www.npr.org");
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
