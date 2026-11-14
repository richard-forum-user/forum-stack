import test from "node:test";
import assert from "node:assert/strict";
import { checkQuotes, REFUSAL } from "../src/quote-check.js";
import { pickSpans } from "../src/spans.js";

const page = "The bill was enacted by the legislature in public session.";
const url = "https://www.maine.gov/bill";

test("accept exact span", () => {
  const quotes = [{ text: page, url }];
  const verdict = checkQuotes({
    answer: `"${page}"`,
    quotes,
    pages: { [url]: page },
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.errors, []);
});

test("accept two exact spans joined by a connective", () => {
  const second = "The act takes effect on the date the secretary certifies it.";
  const quotes = [
    { text: page, url },
    { text: second, url },
  ];
  const verdict = checkQuotes({
    answer: `"${page}" and "${second}"`,
    quotes,
    pages: { [url]: `${page} ${second}` },
  });
  assert.equal(verdict.ok, true);
});

test("reject paraphrase", () => {
  const verdict = checkQuotes({
    answer: `"The bill passed easily and everyone agreed."`,
    quotes: [{ text: "The bill passed easily and everyone agreed.", url }],
    pages: { [url]: page },
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.refusal, REFUSAL);
  assert.ok(verdict.errors.includes("paraphrase"));
});

test("reject off-list host", () => {
  const off = "https://example.com/story";
  const verdict = checkQuotes({
    answer: `"${page}"`,
    quotes: [{ text: page, url: off }],
    pages: { [off]: page },
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.refusal, REFUSAL);
  assert.ok(verdict.errors.some((error) => error.startsWith("off-list host")));
});

test("refuse when empty", () => {
  const verdict = checkQuotes({ answer: "", quotes: [], pages: {} });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.refusal, REFUSAL);
  assert.deepEqual(verdict.errors, ["no matching quote"]);
});

test("reject a bridge that ranks or steers", () => {
  const verdict = checkQuotes({
    answer: `"${page}" which is better`,
    quotes: [{ text: page, url }],
    pages: { [url]: page },
  });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.errors.some((error) => error.startsWith("non-connective")));
});

test("pickSpans returns an exact substring or nothing", () => {
  const quotes = pickSpans("When was the bill enacted?", page, url);
  assert.equal(quotes.length, 1);
  assert.equal(page.includes(quotes[0].text), true);
  assert.deepEqual(pickSpans("zzzz-not-in-page", page, url), []);
});

test("pickSpans prefers the bill title over the navigation chrome", () => {
  const nav = "Skip Navigation Chamber Status, HP 207 Legislative Information Maine Legislature 132nd Maine Legislature, Second Regular Session Choose Another Bill Select Paper or LD with radio button.";
  const title = "LD # 307 An Act to Establish the Maine Data Center Coordination Council and Place a Temporary Limitation on Certain Data Centers (TITLE CHANGE)";
  const text = `${nav} This page looks better if you use JavaScript. ${title} Referred to Committee on Energy, Utilities and Technology on Jan 30, 2025.`;
  const quotes = pickSpans("Tell me about Maine LD 307", text, "https://legislature.maine.gov/legis/bills/display_ps.asp?LD=307&snum=132");
  assert.ok(quotes.length > 0);
  assert.equal(quotes[0].text.includes("An Act to Establish"), true);
  assert.equal(quotes.some((quote) => quote.text.includes("Skip Navigation")), false);
  assert.equal(text.includes(quotes[0].text), true);
});
