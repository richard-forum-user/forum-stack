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
