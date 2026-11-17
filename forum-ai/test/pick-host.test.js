import test from "node:test";
import assert from "node:assert/strict";
import { chooseHost, hostUrl, isVague, pageRefusal, parseHost, resolveHost, VAGUE_PAGE } from "../src/pick-host.js";
import { SESSION_LIST_URL } from "../src/session-bills.js";
import { renderPage } from "../src/page.js";

test("the model text is only a host", () => {
  assert.equal(parseHost("congress.gov"), "congress.gov");
  assert.equal(parseHost("Open pubmed.ncbi.nlm.nih.gov for this."), "pubmed.ncbi.nlm.nih.gov");
  assert.equal(parseHost("none"), "");
  assert.equal(parseHost("https://example.com/story"), "");
});

test("a US Senate question opens congress.gov, not the Maine bill list", async () => {
  const comment = "What is the US Senate considering?";
  assert.equal(resolveHost(comment, "legislature.maine.gov"), "congress.gov");
  const seen = [];
  const choice = await chooseHost(comment, async (text) => {
    seen.push(text);
    return "legislature.maine.gov";
  });
  assert.equal(seen.length, 1);
  assert.equal(choice.host, "congress.gov");
  assert.equal(choice.url.startsWith("https://www.congress.gov/search?q="), true);
  assert.equal(choice.url.includes("legislature.maine.gov"), false);
});

test("Maine bills open the Maine legislature only when the question is about Maine", () => {
  assert.equal(resolveHost("What legislation is coming up for the next session in Maine", "apnews.com"), "legislature.maine.gov");
  assert.equal(resolveHost("Tell me about LD 307", "congress.gov"), "legislature.maine.gov");
  assert.equal(resolveHost("What is Congress doing this week?", "legislature.maine.gov"), "congress.gov");
  assert.equal(hostUrl("legislature.maine.gov", "What is Congress doing?"), "");
});

test("a Maine legislation question opens the legislature, not congress.gov", async () => {
  const comment = "Hello, I'd like to learn more about Maine Legislation";
  assert.equal(resolveHost(comment, "none"), "legislature.maine.gov");
  assert.equal(resolveHost(comment, "congress.gov"), "legislature.maine.gov");
  assert.equal(resolveHost(comment, ""), "legislature.maine.gov");
  const seen = [];
  const choice = await chooseHost(comment, async (text) => {
    seen.push(text);
    return "congress.gov";
  });
  assert.equal(seen.length, 1);
  assert.equal(choice.host, "legislature.maine.gov");
  assert.equal(choice.url, SESSION_LIST_URL);
  assert.equal(choice.url.includes("congress.gov"), false);
});

test("what is this stays a refusal with a page link and no model facts", async () => {
  assert.equal(isVague("What is this?"), true);
  const choice = await chooseHost("What is this?", async () => {
    throw new Error("should not be asked");
  });
  assert.equal(choice.calls, 0);
  assert.equal(choice.host, "");
  const answer = pageRefusal();
  assert.equal(answer.includes(VAGUE_PAGE), true);
  assert.equal(answer.includes("I think"), false);
  const html = renderPage({
    authorized: true,
    kind: "admin",
    thread: [{ role: "assistant", text: answer, quotes: [] }],
  });
  assert.match(html, new RegExp(`href="${VAGUE_PAGE.replace(/[.]/g, "\\.")}"`));
  assert.equal(html.includes("<p>and</p>"), false);
});
