import test from "node:test";
import assert from "node:assert/strict";
import { runAgent } from "../src/agents.js";
import { runCoordinator } from "../src/coordinator.js";
import { renderPage } from "../src/page.js";
import { asksMaineBills, asksSessionBills, billDisplayLinks, pickBillQuotes, sessionMissLine, sessionNumbers, SESSION_LIST_URL } from "../src/session-bills.js";

const COMMENT = "I'm curious about what legislation is coming up for the next session in Maine";
const SEARCH = "https://legislature.maine.gov/bills/default_ps.asp";
const HOME = "https://legislature.maine.gov/";
const DIR133 = "https://legislature.maine.gov/bills/billdirectory_ps.asp?ldFrom=1&snum=133";
const DIR132 = "https://legislature.maine.gov/bills/billdirectory_ps.asp?ldFrom=1&snum=132";
const DISPLAY = "https://legislature.maine.gov/bills/display_ps.asp?snum=132&paper=SP0029&PID=1456";
const MAINE_ARTICLE = "https://www.maine.gov/governor/news/legislation-next-session";
const AP_ARTICLE = "https://apnews.com/article/maine-legislation-next-session";
const MAINE_LINE = "Maine legislation for the next session is coming up in hearings across the state.";
const AP_LINE = "The Associated Press reports Maine legislation for the next session is coming up this winter.";

const PAGES = {
  [SEARCH]: "Bill Tracking and Text Search Session Any 133 132 131 130 Maine Legislature",
  [HOME]: "132 nd Maine Legislature. The Second Regular Session of the 132nd Maine Legislature convened January 7, 2026 and adjourned sine die Wednesday, April 29, 2026.",
  [DIR133]: "133rd Maine Legislature LD 0 LD 1 - LD 200 Bill Directory, LD 1 to 200 Legislative documents from 1 to 200 are not available at this time.",
  [DIR132]: "132nd Maine Legislature LD 0 LD 1 - LD 200 1. LD 1, SP 29, 132nd Legislature An Act to Increase Storm Preparedness for Maine's Communities, Homes and Infrastructure Bill & Fiscal Information Printed LD PDF 2. LD 2, SP 11, 132nd Legislature An Act to Allow Military Vehicles Purchased for Civilian Use to Be Registered and Operated on Maine Roads Bill & Fiscal Information",
  [DISPLAY]: "Paper SP 29 LD # 1 An Act to Increase Storm Preparedness for Maine's Communities, Homes and Infrastructure (EMERGENCY) (GOVERNOR'S BILL) Text and Disposition",
  [MAINE_ARTICLE]: MAINE_LINE,
  [AP_ARTICLE]: AP_LINE,
};

function searchPage(article) {
  return `<html><body><p>Results</p><a href="${article}">Read</a></body></html>`;
}

function fetchImpl(url) {
  const href = String(url);
  if (href.startsWith("https://www.maine.gov/search")) return new Response(searchPage(MAINE_ARTICLE), { status: 200, headers: { "content-type": "text/html" } });
  if (href.startsWith("https://apnews.com/search")) return new Response(searchPage(AP_ARTICLE), { status: 200, headers: { "content-type": "text/html" } });
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
  assert.equal(asksMaineBills("Hello, I'd like to learn more about Maine Legislation"), true);
  assert.equal(asksMaineBills("Tell me about Maine LD 307"), false);
  assert.equal(asksMaineBills("What is the US Senate considering?"), false);
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

test("a next-session question opens the Maine bill list and not a press catalog", async () => {
  const calls = [];
  const order = [];
  const reply = await runCoordinator({
    comment: COMMENT,
    urls: [],
    model: async () => "apnews.com",
    ask: async (group, payload) => {
      order.push(payload.stage);
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
  assert.deepEqual(order, ["bills"]);
  assert.ok(calls.includes(SEARCH));
  assert.ok(calls.includes(DIR133));
  assert.equal(calls.includes(DIR132), false);
  assert.equal(calls.includes(DISPLAY), false);
  assert.equal(calls.includes(HOME), false);
  assert.equal(calls.includes(MAINE_ARTICLE), false);
  assert.equal(calls.includes(AP_ARTICLE), false);
  assert.equal(reply.ok, true);
  assert.equal(reply.pace, "That will take a moment. I'll check legislature.maine.gov.");
  assert.deepEqual(reply.stages.map((stage) => stage.line), ["Checking legislature.maine.gov."]);
  assert.ok(reply.quotes.some((quote) => quote.text === "133rd Maine Legislature" && quote.url === DIR133));
  assert.ok(reply.quotes.some((quote) => quote.text === "Legislative documents from 1 to 200 are not available at this time."));
  assert.equal(reply.quotes.some((quote) => /\b(An Act|Resolve)\b/.test(quote.text)), false);
  assert.equal(reply.quotes.some((quote) => quote.text.includes("132nd")), false);
  const html = renderPage({
    authorized: true,
    kind: "admin",
    thread: [{
      role: "assistant",
      pace: reply.pace,
      stages: reply.stages,
      close: reply.close,
      quotes: reply.quotes,
    }],
  });
  assert.match(html, /That will take a moment\. I'll check legislature\.maine\.gov/);
  assert.equal(html.includes("<p>and</p>"), false);
  assert.equal(html.includes("LD # 1"), false);
});

test("a Maine legislation question quotes the legislature page, not congress.gov", async () => {
  const comment = "Hello, I'd like to learn more about Maine Legislation";
  const calls = [];
  const reply = await runCoordinator({
    comment,
    urls: [],
    model: async () => "congress.gov",
    ask: async (group, payload) => runAgent({
      group,
      comment: payload.comment,
      urls: payload.urls,
      fetchImpl: async (url) => {
        calls.push(String(url));
        return fetchImpl(url);
      },
    }),
  });
  assert.ok(calls.includes(SEARCH));
  assert.ok(calls.includes(DIR133));
  assert.equal(calls.some((url) => url.includes("congress.gov")), false);
  assert.equal(reply.ok, true);
  assert.equal(reply.pace, "That will take a moment. I'll check legislature.maine.gov.");
  assert.ok(reply.quotes.some((quote) => quote.text === "133rd Maine Legislature" && quote.url === DIR133));
  assert.equal(reply.answer.includes("congress.gov"), false);
  assert.equal(reply.quotes.some((quote) => /\b(An Act|Resolve)\b/.test(quote.text)), false);
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
