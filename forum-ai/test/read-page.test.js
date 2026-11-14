import test from "node:test";
import assert from "node:assert/strict";
import { readAllowlisted } from "../src/read-page.js";
import { runAgent } from "../src/agents.js";

test("off-list host is not fetched", async () => {
  let called = false;
  const result = await readAllowlisted("https://example.com/a", "gov", async () => {
    called = true;
    throw new Error("fetched");
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test("a press agent does not fetch a .gov page", async () => {
  let called = false;
  const result = await readAllowlisted("https://www.maine.gov/bill", "press", async () => {
    called = true;
    throw new Error("fetched");
  });
  assert.equal(result, null);
  assert.equal(called, false);
});

test("redirect to an off-list host is not followed", async () => {
  const calls = [];
  const result = await readAllowlisted("https://doi.org/10.1000/xyz", "academia", async (url) => {
    calls.push(String(url));
    return new Response(null, { status: 302, headers: { location: "https://example.com/no" } });
  });
  assert.equal(result, null);
  assert.deepEqual(calls, ["https://doi.org/10.1000/xyz"]);
});

test("an allowlisted page is fetched and quoted exactly", async () => {
  const html = "<html><body><p>The bill was enacted by the legislature in public session.</p></body></html>";
  const calls = [];
  const result = await runAgent({
    group: "gov",
    comment: "When was the bill enacted by the legislature?",
    urls: ["https://www.maine.gov/bill", "https://example.com/no"],
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    },
  });
  assert.deepEqual(calls, ["https://www.maine.gov/bill"]);
  assert.equal(result.quotes.length, 1);
  assert.equal(result.pages[result.quotes[0].url].includes(result.quotes[0].text), true);
});
