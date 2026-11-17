import test from "node:test";
import assert from "node:assert/strict";
import { ForumAiSession } from "../src/session.js";

function memoryStorage() {
  const map = new Map();
  return {
    map,
    async put(key, value) {
      map.set(key, value);
    },
    async get(key) {
      return map.get(key);
    },
  };
}

function envWith(storage, onCoordinator) {
  return {
    FORUM_AI_ADMIN_PASSWORD: "test-only-password",
    COORDINATOR: {
      idFromName() {
        return "coordinator";
      },
      get() {
        return {
          async fetch(request) {
            return onCoordinator(request);
          },
        };
      },
    },
    storage,
  };
}

test("a forum session cookie opens the page with no second password", async () => {
  const storage = memoryStorage();
  const session = new ForumAiSession({ storage }, envWith(storage, async () => Response.json({})));
  const response = await session.fetch(new Request("https://yourcommunity.forum/forum-ai", {
    headers: { cookie: "forum_session=abc123" },
  }));
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /name="message"/);
  assert.doesNotMatch(html, /type="password"/);
  assert.doesNotMatch(html, /name="sources"/);
  assert.doesNotMatch(html, /name="comment"/);
  assert.ok([...storage.map.values()].includes("forum_session=abc123"));
});

test("oauth bearer is enough and an anonymous visitor only sees admin login", async () => {
  const storage = memoryStorage();
  const session = new ForumAiSession({ storage }, envWith(storage, async () => Response.json({})));
  const anon = await session.fetch(new Request("https://yourcommunity.forum/forum-ai"));
  const anonHtml = await anon.text();
  assert.match(anonHtml, /type="password"/);
  assert.match(anonHtml, /name="username"/);
  assert.doesNotMatch(anonHtml, /name="message"/);
  assert.doesNotMatch(anonHtml, /name="comment"/);
  assert.doesNotMatch(anonHtml, /name="sources"/);

  const oauth = await session.fetch(new Request("https://yourcommunity.forum/forum-ai", {
    headers: { authorization: "Bearer already-in-the-browser" },
  }));
  const html = await oauth.text();
  assert.match(html, /name="message"/);
  assert.doesNotMatch(html, /type="password"/);
  assert.doesNotMatch(html, /name="sources"/);
});

test("the coordinator is called without the forum cookie", async () => {
  const storage = memoryStorage();
  let seen;
  const session = new ForumAiSession({ storage }, envWith(storage, async (request) => {
    seen = {
      cookie: request.headers.get("cookie"),
      authorization: request.headers.get("authorization"),
      body: await request.json(),
    };
    return Response.json({
      ok: false,
      answer: "These sources do not contain that answer.",
      quotes: [],
      refused: [],
    });
  }));
  const response = await session.fetch(new Request("https://yourcommunity.forum/forum-ai", {
    method: "POST",
    headers: {
      cookie: "forum_session=abc123",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      comment: "Was the bill enacted?",
      sources: "https://www.maine.gov/bill",
    }),
  }));
  assert.equal(response.status, 200);
  assert.equal(seen.cookie, null);
  assert.equal(seen.authorization, null);
  assert.deepEqual(seen.body, {
    comment: "Was the bill enacted?",
    urls: ["https://www.maine.gov/bill"],
  });
  assert.equal(JSON.stringify(seen.body).includes("abc123"), false);
});

test("anonymous check does not call the coordinator", async () => {
  const storage = memoryStorage();
  let called = false;
  const session = new ForumAiSession({ storage }, envWith(storage, async () => {
    called = true;
    return Response.json({});
  }));
  const response = await session.fetch(new Request("https://yourcommunity.forum/forum-ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ comment: "hello there", sources: "https://example.com/no" }),
  }));
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("admin password is checked and not stored", async () => {
  const storage = memoryStorage();
  const session = new ForumAiSession({ storage }, envWith(storage, async () => Response.json({})));
  const bad = await session.fetch(new Request("https://yourcommunity.forum/forum-ai/admin", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=admin&password=wrong-password-value",
  }));
  assert.equal(bad.status, 401);

  const good = await session.fetch(new Request("https://yourcommunity.forum/forum-ai/admin", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=admin&password=test-only-password",
  }));
  assert.equal(good.status, 303);
  const set = good.headers.getSetCookie();
  assert.ok(set.some((row) => row.startsWith("forum_ai_admin=")));
  for (const value of storage.map.values()) {
    assert.notEqual(value, "test-only-password");
    assert.equal(String(value).includes("test-only-password"), false);
  }
});

test("a signed-in message is kept in the chat thread", async () => {
  const storage = memoryStorage();
  const session = new ForumAiSession({ storage }, envWith(storage, async () => Response.json({
    ok: true,
    answer: "\"The bill was enacted in 2024.\"",
    quotes: [{ text: "The bill was enacted in 2024.", url: "https://www.maine.gov/bill" }],
    refused: [],
  })));
  const opened = await session.fetch(new Request("https://yourcommunity.forum/forum-ai", {
    headers: { cookie: "forum_session=abc123" },
  }));
  const sid = opened.headers.getSetCookie().find((row) => row.startsWith("forum_ai_sid="));
  const cookie = `forum_session=abc123; ${sid.split(";")[0]}`;
  const posted = await session.fetch(new Request("https://yourcommunity.forum/forum-ai", {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "message=Was+the+bill+enacted%3F+https%3A%2F%2Fwww.maine.gov%2Fbill",
  }));
  const html = await posted.text();
  assert.equal(posted.status, 200);
  assert.match(html, /Was the bill enacted\?/);
  assert.match(html, /That will take a moment/);
  assert.match(html, /Other \.gov pages checked/);
  assert.ok(html.indexOf("That will take a moment") < html.indexOf("The bill was enacted in 2024."));
  assert.match(html, /The bill was enacted in 2024\./);
  assert.equal(html.includes("<p>and</p>"), false);
  assert.match(html, /class="user"/);
  assert.match(html, /class="assistant"/);
  assert.match(html, /name="message"/);
  assert.doesNotMatch(html, /name="sources"/);
  assert.doesNotMatch(html, /type="password"/);

  const again = await session.fetch(new Request("https://yourcommunity.forum/forum-ai", {
    headers: { cookie },
  }));
  const kept = await again.text();
  assert.match(kept, /Was the bill enacted\?/);
  assert.match(kept, /The bill was enacted in 2024\./);
});

test("the pacing sentence is on the page before the check finishes", async () => {
  const storage = memoryStorage();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const session = new ForumAiSession({ storage }, envWith(storage, async () => {
    await gate;
    return Response.json({
      ok: true,
      answer: "\"133rd Maine Legislature\"",
      quotes: [{ text: "133rd Maine Legislature", url: "https://legislature.maine.gov/bills/billdirectory_ps.asp?ldFrom=1&snum=133" }],
      refused: [],
    });
  }));
  const opened = await session.fetch(new Request("https://yourcommunity.forum/forum-ai", {
    headers: { cookie: "forum_session=abc123" },
  }));
  const sid = opened.headers.getSetCookie().find((row) => row.startsWith("forum_ai_sid="));
  const cookie = `forum_session=abc123; ${sid.split(";")[0]}`;
  const posted = await session.fetch(new Request("https://yourcommunity.forum/forum-ai", {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "message=I%27m+curious+about+what+legislation+is+coming+up+for+the+next+session+in+Maine",
  }));
  const reader = posted.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  while (!html.includes("That will take a moment")) {
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    html += decoder.decode(chunk.value, { stream: true });
  }
  assert.equal(html.includes("133rd Maine Legislature"), false);
  release();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    html += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(html, /Bill list checked/);
  assert.match(html, /133rd Maine Legislature/);
  assert.ok(html.indexOf("That will take a moment") < html.indexOf("133rd Maine Legislature"));
  assert.equal(html.includes("<p>and</p>"), false);
});
