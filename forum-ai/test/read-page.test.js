import test from "node:test";
import assert from "node:assert/strict";
import { readAllowlisted } from "../src/read-page.js";
import { runAgent } from "../src/agents.js";
import { pdfToText } from "../src/pdf-text.js";

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

test("pdf text is the sentence stored in the file", async () => {
  const sentence = "The bill was enacted by the legislature in public session.";
  const body = `BT (${sentence}) Tj ET`;
  const pdf = `%PDF-1.1\n1 0 obj\n<< /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\ntrailer\n<< >>\n%%EOF`;
  assert.equal(await pdfToText(new TextEncoder().encode(pdf)), sentence);
});

test("a keyword search opens the matching article", async () => {
  const pubmed = "https://pubmed.ncbi.nlm.nih.gov/?term=%22data%20centers%22";
  const pmcSearch = "https://pmc.ncbi.nlm.nih.gov/search/?term=E2SVM%20cloud%20data%20centers";
  const article = "https://pmc.ncbi.nlm.nih.gov/articles/PMC11164395/";
  const sentence = "Cloud data centers present a challenge to environmental sustainability because of their significant energy consumption.";
  const calls = [];
  const result = await runAgent({
    group: "academia",
    comment: "what are experts saying about LD 307 maine data center data centers",
    urls: [pubmed],
    fetchImpl: async (url) => {
      const href = String(url);
      calls.push(href);
      if (href.startsWith(article)) {
        return new Response(`<p>${sentence}</p>`, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (href.includes("pmc.ncbi.nlm.nih.gov/search")) {
        return new Response(`<a class="usa-link docsum-title docsum-link" href="${article}">E2SVM cloud data centers</a>`, {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response('<a class="docsum-title" href="/38857300/">E2SVM approach in cloud data centers.</a>', {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    },
  });
  assert.ok(calls.includes(pmcSearch) || calls.some((url) => url.includes("pmc.ncbi.nlm.nih.gov/search")));
  assert.ok(calls.includes(article));
  assert.equal(result.quotes.some((quote) => quote.text === sentence && quote.url === article), true);
});

test("a bill summary also fetches the printed bill text", async () => {
  const pdf = "https://legislature.maine.gov/legis/bills/getPDF.asp?paper=HP0207&item=2&snum=132";
  const calls = [];
  const summary = `<a href="${pdf}">Printed Document PDF</a><p>LD # 307 An Act to Establish the Maine Data Center Coordination Council and Place a Temporary Limitation on Certain Data Centers (TITLE CHANGE)</p>`;
  const bill = "<p>L.D. 307 Sec. 1. Temporary limitation on certain data centers. Notwithstanding any provision of law to the contrary, prior to November 1, 2027, a municipality may not issue a permit.</p>";
  const result = await runAgent({
    group: "gov",
    comment: "Tell me about LD 307 in greater detail, what are experts saying?",
    urls: ["https://legislature.maine.gov/legis/bills/display_ps.asp?LD=307&snum=132"],
    fetchImpl: async (url) => {
      calls.push(String(url));
      const html = String(url).includes("getPDF") ? bill : summary;
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    },
  });
  assert.deepEqual(calls, [
    "https://legislature.maine.gov/legis/bills/display_ps.asp?LD=307&snum=132",
    pdf,
  ]);
  assert.equal(result.quotes.some((quote) => quote.text.includes("Temporary limitation")), true);
});

test("a search page does not fetch an off-list result", async () => {
  const calls = [];
  const html = `<a href="https://example.com/ld307">LD 307</a><a href="https://www.maine.gov/agencies/ld307">LD 307 note</a>`;
  const result = await runAgent({
    group: "gov",
    comment: "Tell me about Maine LD 307",
    urls: ["https://www.maine.gov/search?q=LD%20307"],
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("agencies")) {
        return new Response("<p>An Act to Establish the Maine Data Center Coordination Council today.</p>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    },
  });
  assert.deepEqual(calls, [
    "https://www.maine.gov/search?q=LD%20307",
    "https://www.maine.gov/agencies/ld307",
  ]);
  assert.equal(result.quotes.some((quote) => quote.text.includes("Data Center Coordination Council")), true);
  assert.equal(calls.some((url) => url.includes("example.com")), false);
});
