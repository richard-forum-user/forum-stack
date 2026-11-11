import { checkReply, urlAllowed } from "./check-reply.js";

const DEFAULT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

function modelId(env) {
  return env.CIVIC_REFEREE_MODEL || DEFAULT_MODEL;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function ensureSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY,
      forum_host TEXT NOT NULL,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_id TEXT,
      body TEXT NOT NULL
    )
  `).run();
}

function forumHost(request) {
  return (request.headers.get("x-forum-host") || new URL(request.url).host || "referee").slice(0, 200);
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function sentencesOf(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 40 && sentence.length <= 500);
}

async function readSource(raw) {
  if (!urlAllowed(raw)) return null;
  const response = await fetch(raw, {
    redirect: "follow",
    headers: { "user-agent": "forum-civic-referee", accept: "text/html, text/plain, application/pdf" },
    signal: AbortSignal.timeout(8000),
  });
  const finalUrl = response.url || raw;
  if (!response.ok || !urlAllowed(finalUrl)) return null;
  const type = response.headers.get("content-type") || "";
  if (type.includes("pdf")) return null;
  const html = await response.text();
  const text = htmlToText(html).slice(0, 20000);
  const sentences = sentencesOf(text).slice(0, 80);
  if (!sentences.length) return null;
  return { url: finalUrl, sentences };
}

function pickSentences(question, sources) {
  const words = new Set(
    String(question || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3)
  );
  const ranked = [];
  for (const source of sources) {
    source.sentences.forEach((sentence, index) => {
      const hay = sentence.toLowerCase();
      let score = 0;
      for (const word of words) if (hay.includes(word)) score += 1;
      ranked.push({ url: source.url, sentence, score, index });
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  const chosen = [];
  const seen = new Set();
  for (const row of ranked) {
    if (chosen.length >= 16) break;
    const key = row.sentence;
    if (seen.has(key)) continue;
    seen.add(key);
    chosen.push(row);
  }
  return chosen;
}

function parseChoice(raw, count) {
  const text = String(raw || "");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const sentence = parsed.sentence;
    if (sentence === null || sentence === undefined) return null;
    const index = Number(sentence);
    if (!Number.isInteger(index) || index < 0 || index >= count) return null;
    return index;
  } catch {
    return null;
  }
}

async function chooseSentence(env, question, rows) {
  const list = rows.map((row, index) => `${index}. ${row.sentence}`).join("\n");
  const result = await env.AI.run(modelId(env), {
    messages: [
      {
        role: "system",
        content: [
          "You are a fact referee. You do not take a side.",
          "You do not write vote tallies and you do not mention seats.",
          "Choose the one numbered sentence that answers the question.",
          "Reply with JSON only: {\"sentence\": <number>} or {\"sentence\": null}.",
          "Use null when none of the sentences contain the answer.",
        ].join(" "),
      },
      { role: "user", content: `Question: ${question}\n\nSentences:\n${list}` },
    ],
  });
  const text = typeof result === "string" ? result : result?.response || result?.result?.response || "";
  return parseChoice(text, rows.length);
}

function refusal(model, time, sources) {
  return {
    answer: "These sources do not contain that answer.",
    quotes: [],
    sources,
    model,
    time,
  };
}

async function answerQuestion(env, question, sourceUrls) {
  const model = modelId(env);
  const time = new Date().toISOString();
  const allowed = [...new Set(sourceUrls.filter(urlAllowed))].slice(0, 4);
  const read = (await Promise.all(allowed.map((url) => readSource(url).catch(() => null)))).filter(Boolean);
  const urls = read.map((source) => source.url);
  if (!read.length) return refusal(model, time, []);
  const rows = pickSentences(question, read);
  if (!rows.length) return refusal(model, time, urls);
  let index = null;
  try {
    index = await chooseSentence(env, question, rows);
  } catch {
    index = null;
  }
  if (index === null) return refusal(model, time, urls);
  const picked = rows[index];
  const reply = {
    answer: `The page says: "${picked.sentence}"`,
    quotes: [{ url: picked.url, text: picked.sentence }],
    sources: urls,
    model,
    time,
  };
  const verdict = checkReply(reply);
  if (!verdict.ok) return refusal(model, time, urls);
  return reply;
}

async function listCalls(db, host) {
  const rows = await db.prepare(
    `SELECT id, created_at, kind, parent_id, body FROM calls WHERE forum_host = ? ORDER BY created_at ASC`
  ).bind(host).all();
  return (rows.results || []).map((row) => ({
    id: row.id,
    at: row.created_at,
    kind: row.kind,
    parentId: row.parent_id,
    record: JSON.parse(row.body),
  }));
}

function renderPage(host, calls) {
  const items = calls.map((call) => {
    const record = call.record || {};
    const quotes = (record.quotes || []).map((quote) =>
      `<blockquote><p>${esc(quote.text)}</p><p><a href="${esc(quote.url)}">${esc(quote.url)}</a></p></blockquote>`
    ).join("");
    const sources = (record.sources || []).map((url) => `<li><a href="${esc(url)}">${esc(url)}</a></li>`).join("");
    const body = call.kind === "ask"
      ? `<p>${esc(record.question || "")}</p>`
      : `<p>${esc(record.answer || "")}</p>${quotes}<ul>${sources}</ul><p>Model: ${esc(record.model || "")}</p><p>Time: <time datetime="${esc(record.time || call.at)}">${esc(record.time || call.at)}</time></p>`;
    const hide = call.kind === "reply"
      ? `<button type="button" data-hide="${esc(call.id)}">Hide for me</button>`
      : "";
    return `<article id="call-${esc(call.id)}" data-call="${esc(call.id)}"><p><strong>${call.kind === "ask" ? "Called" : "Referee"}</strong></p>${body}${hide}</article>`;
  }).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Civic AI referee</title>
  <style>
    body { margin: 0; background: #f3f6f8; color: #152028; font: 16px/1.5 system-ui, sans-serif; }
    main { max-width: 40rem; margin: 0 auto; padding: 16px 16px 64px; }
    a { color: #152028; }
    article, form { background: #fff; border: 1px solid #1520281a; border-radius: 14px; padding: 16px; margin: 0 0 12px; }
    textarea, button { font: inherit; }
    textarea { width: 100%; min-height: 5rem; }
    button { margin-top: 8px; }
    .hidden { display: none; }
  </style>
</head>
<body>
<main>
  <p>Watching ${esc(host)}. Silent until called.</p>
  <h1>Civic AI referee</h1>
  <p>Call it with a question. It quotes .gov pages and LegiScan, and it says so when those sources do not contain the answer. It does not browse the open web, write vote tallies, cite a simulated seat, or take a side.</p>
  <p>Called from <a href="https://maine.yourcommunity.forum/civic-ai">Maine</a>, <a href="https://nh.yourcommunity.forum/civic-ai">New Hampshire</a>, <a href="https://vermont.yourcommunity.forum/civic-ai">Vermont</a>, and the <a href="https://podlink-ai-test-state.forum-community.workers.dev/civic-ai">test area</a>.</p>
  <section id="thread">${items || "<p>No calls yet.</p>"}</section>
  <form method="post" action="/civic-ai">
    <label>Question<textarea name="question" required></textarea></label>
    <label>Source URLs, one per line. Only .gov and LegiScan are read.<textarea name="sources" placeholder="https://legislature.maine.gov/legis/bills/display_ps.asp?LD=307&amp;snum=132"></textarea></label>
    <label>Correct an earlier reply by its id. The earlier reply stays.<input name="parent" style="width:100%;font:inherit"></label>
    <button type="submit">Call the referee</button>
  </form>
</main>
<script>
  var key = "civic-referee-hidden";
  function hidden() { try { return JSON.parse(localStorage.getItem(key) || "[]"); } catch (e) { return []; } }
  function paint() {
    var ids = hidden();
    document.querySelectorAll("[data-call]").forEach(function (node) {
      node.classList.toggle("hidden", ids.indexOf(node.getAttribute("data-call")) >= 0);
    });
  }
  document.addEventListener("click", function (ev) {
    var id = ev.target && ev.target.getAttribute && ev.target.getAttribute("data-hide");
    if (!id) return;
    var ids = hidden();
    if (ids.indexOf(id) < 0) ids.push(id);
    localStorage.setItem(key, JSON.stringify(ids));
    paint();
  });
  paint();
</script>
</body>
</html>`;
}

async function handleCall(request, env) {
  const host = forumHost(request);
  let question = "";
  let sources = [];
  let parent = "";
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const body = await request.json();
    question = String(body.question || "");
    sources = Array.isArray(body.sources) ? body.sources.map(String) : [];
    parent = String(body.parent || "");
  } else {
    const form = await request.formData();
    question = String(form.get("question") || "");
    sources = String(form.get("sources") || "").split(/\s+/).filter(Boolean);
    parent = String(form.get("parent") || "");
  }
  question = question.trim().slice(0, 2000);
  if (!question) return json({ error: "missing question" }, 400);
  await ensureSchema(env.DB);
  const askId = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO calls (id, forum_host, created_at, kind, parent_id, body) VALUES (?, ?, ?, 'ask', ?, ?)`
  ).bind(askId, host, now, parent || null, JSON.stringify({ question })).run();
  const reply = await answerQuestion(env, question, sources);
  const replyId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO calls (id, forum_host, created_at, kind, parent_id, body) VALUES (?, ?, ?, 'reply', ?, ?)`
  ).bind(replyId, host, reply.time, askId, JSON.stringify(reply)).run();
  if (type.includes("application/json")) return json({ askId, replyId, reply });
  return Response.redirect(new URL("/civic-ai", request.url), 303);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname === "/" ? "/civic-ai" : url.pathname;
    if (path === "/civic-ai/status" && request.method === "GET") {
      return json({ silent: true, model: modelId(env) });
    }
    if (path === "/civic-ai/thread" && request.method === "GET") {
      await ensureSchema(env.DB);
      return json({ silent: true, calls: await listCalls(env.DB, forumHost(request)) });
    }
    if (path === "/civic-ai" && request.method === "GET") {
      await ensureSchema(env.DB);
      const calls = await listCalls(env.DB, forumHost(request));
      return new Response(renderPage(forumHost(request), calls), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (path === "/civic-ai" && request.method === "POST") return handleCall(request, env);
    return new Response("not found", { status: 404 });
  },
};
