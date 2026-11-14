import test from "node:test";
import assert from "node:assert/strict";
import { groupOf, hostGroup, urlAllowed } from "../src/allowlist.js";

test("gov allows .gov and legiscan.com only", () => {
  assert.equal(hostGroup("www.maine.gov"), "gov");
  assert.equal(hostGroup("legiscan.com"), "gov");
  assert.equal(hostGroup("api.legiscan.com"), "gov");
  assert.equal(urlAllowed("https://www.maine.gov/bill", "gov"), true);
  assert.equal(hostGroup("www.nih.gov"), "gov");
  assert.equal(hostGroup("pubmed.ncbi.nlm.nih.gov"), "academia");
  assert.equal(urlAllowed("https://legiscan.com/ME/bill/LD1/2025", "gov"), true);
  assert.equal(urlAllowed("https://www.maine.gov/bill", "press"), false);
});

test("academia allows doi.org, pubmed, and pmc", () => {
  assert.equal(groupOf("https://doi.org/10.1000/xyz"), "academia");
  assert.equal(groupOf("https://dx.doi.org/10.1000/xyz"), "academia");
  assert.equal(groupOf("https://pubmed.ncbi.nlm.nih.gov/123"), "academia");
  assert.equal(groupOf("https://pmc.ncbi.nlm.nih.gov/articles/PMC1/"), "academia");
  assert.equal(urlAllowed("https://doi.org/10.1/abc", "academia"), true);
  assert.equal(urlAllowed("https://doi.org/10.1/abc", "gov"), false);
});

test("press allows the explicit host list", () => {
  for (const host of ["apnews.com", "reuters.com", "npr.org", "bbc.com", "pbs.org"]) {
    assert.equal(hostGroup(host), "press", host);
    assert.equal(hostGroup(`www.${host}`), "press", host);
    assert.equal(urlAllowed(`https://www.${host}/story`, "press"), true, host);
  }
});

test("reject off-list host", () => {
  for (const raw of [
    "https://example.com/a",
    "https://en.wikipedia.org/wiki/Maine",
    "https://www.nytimes.com/a",
    "https://www.bbc.co.uk/news",
    "https://wiley.com/doi/full/10.1/abc",
    "http://www.maine.gov/bill",
    "https://user:pass@www.maine.gov/bill",
    "not a url",
  ]) {
    assert.equal(urlAllowed(raw), false, raw);
    assert.equal(groupOf(raw), null, raw);
  }
});
