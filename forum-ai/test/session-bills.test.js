import test from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../src/agents.js";
import { runCoordinator } from "../src/coordinator.js";
import { renderPage } from "../src/page.js";
import { searchSeeds } from "../src/search-seeds.js";
import { asksSessionBills, billDisplayLinks, pickBillQuotes, sessionMissLine, sessionNumbers, SESSION_LIST_URL } from "../src/session-bills.js";

const COMMENT = "I'm curious about what legislation is coming up for the next session in Maine";
const SEARCH = "https://legislature.maine.gov/bills/default_ps.asp";
const HOME = "https://legislature.maine.gov/";
const DIR133 = "https://legislature.maine.gov/bills/billdirectory_ps.asp?ldFrom=1&snum=133";
const DIR132 = "https://legislature.maine.gov/bills/billdirectory_ps.asp?ldFrom=1&snum=132";
const DISPLAY = "https://legislature.maine.gov/bills/display_ps.asp?snum=132&paper=SP0029&PID=1456";

const PAGES = {
  [SEARCH]: "Bill Tracking and Text Search Session Any 133 132 131 130 Maine Legislature",
  [HOME]: "132 nd Maine Legislature. The Second Regular Session of the 132nd Maine Legislature convened January 7, 2026 and adjourned sine die Wednesday, April 29, 2026.",
  [DIR133]: "133rd Maine Legislature LD 0 LD 1 - LD 200 Bill Directory, LD 1 to 200 Legislative documents from 1 to 200 are not available at this time.",
  [DIR132]: "132nd Maine Legislature LD 0 LD 1 - LD 200 1. LD 1, SP 29, 132nd Legislature An Act to Increase Storm Preparedness for Maine's Communities, Homes and Infrastructure Bill & Fiscal Information Printed LD PDF 2. LD 2, SP 11, 132nd Legislature An Act to Allow Military Vehicles Purchased for Civilian Use to Be Registered and Operated on Maine Roads Bill & Fiscal Information",
  [DISPLAY]: "Paper SP 29 LD # 1 An Act to Increase Storm Preparedness for Maine's Communities, Homes and Infrastructure (EMERGENCY) (GOVERNOR'S BILL) Text and Disposition",
};

function fetchImpl(url) {
  const href = String(url);
  const html = PAGES[href];
  if (!html) return new Response("missing", { status: 404 });
  return new Response(`<html><body><p>${html}</p></body></html>`, {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

test("a next-session question is not treated as a single bill", () => {
  assert.equal(asksSessionBills(COMMENT), true);
  assert.equal(asksSessionBills("Tell me about Maine LD 307"), false);
  assert.equal(asksSessionBills("Hello"), false);
});

test("session numbers come from the bills search list", () => {
  assert.deepEqual(sessionNumbers(PAGES[SEARCH]).slice(0, 2), [133, 132]);
  assert.deepEqual(billDisplayLinks(PAGES[DIR132]), [DISPLAY, "https://legislature.maine.gov/bills/display_ps.asp?snum=132&paper=SP0011&PID=1456"]);
});

test("bill list lines are exact page substrings", () => {
  const quotes = pickBillQuotes(PAGES[DIR132], DIR132);
  assert.ok(quotes.some((quote) => quote.text === "132nd Maine Legislature"));
  assert.ok(quotes.some((quote) => quote.text.startsWith("LD 1, SP 29, 132nd Legislature An Act to Increase Storm Preparedness")));
  for (const quote of quotes) assert.equal(PAGES[DIR132].includes(quote.text), true);
  const missing = pickBillQuotes(PAGES[DIR133], DIR133);
  assert.ok(missing.some((quote) => quote.text === "133rd Maine Legislature"));
  assert.ok(missing.some((quote) => quote.text === "Legislative documents from 1 to 200 are not available at this time."));
});

test("a next-session question opens the bill list and quotes filed bills", async () => {
  assert.deepEqual(searchSeeds(COMMENT), [SEARCH, HOME]);
  const calls = [];
  const reply = await runCoordinator({
    comment: COMMENT,
    urls: [],
    ask: async (group, payload) => {
      assert.equal(group, "gov");
      return runAgent({
        group,
        comment: payload.comment,
        urls: payload.urls,
        fetchImpl: async (url) => {
          calls.push(String(url));
          return fetchImpl(url);
        },
      });
    },
  });
  assert.ok(calls.includes(SEARCH));
  assert.ok(calls.includes(DIR133));
  assert.ok(calls.includes(DIR132));
  assert.ok(calls.includes(DISPLAY));
  assert.equal(reply.ok, true);
  assert.equal(reply.lead, "Looking at legislature.maine.gov");
  assert.ok(reply.quotes.some((quote) => quote.text === "133rd Maine Legislature" && quote.url === DIR133));
  assert.ok(reply.quotes.some((quote) => quote.text === "132nd Maine Legislature"));
  assert.ok(reply.quotes.some((quote) => quote.text === "Legislative documents from 1 to 200 are not available at this time."));
  const acts = reply.quotes.filter((quote) => quote.text.includes("An Act"));
  assert.ok(acts.length >= 2);
  assert.ok(acts.some((quote) => quote.url === DISPLAY && quote.text.startsWith("LD # 1 An Act to Increase Storm Preparedness")));
  assert.equal(reply.quotes.some((quote) => quote.text.includes("April 29")), false);
  assert.equal(reply.quotes.some((quote) => quote.text.includes("January 7")), false);
  assert.equal(reply.quotes.some((quote) => quote.text === "132 nd Maine Legislature"), false);
});

test("a session search with no quote names the list and does not guess", async () => {
  const reply = await runCoordinator({
    comment: COMMENT,
    urls: [],
    ask: async () => ({ quotes: [], pages: {} }),
  });
  assert.equal(reply.ok, false);
  assert.deepEqual(reply.quotes, []);
  assert.equal(reply.answer, sessionMissLine());
  assert.equal(reply.answer, `I can't answer that without leaving the quoted sources. The session list is at ${SESSION_LIST_URL}.`);
  assert.equal(reply.answer.includes("132"), false);
  assert.equal(reply.answer.includes("133"), false);
  assert.equal(reply.lead, "");
  const html = renderPage({
    authorized: true,
    kind: "admin",
    thread: [{ role: "assistant", text: reply.answer, quotes: [] }],
  });
  assert.match(html, /I can't answer that without leaving the quoted sources/);
  assert.match(html, new RegExp(`href="${SESSION_LIST_URL.replace(/[.]/g, "\\.")}"`));
});
