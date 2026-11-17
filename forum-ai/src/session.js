import { adminMatches, forumCredential, parseCookies } from "./auth.js";
import { extractUrls } from "./allowlist.js";
import { quoteStage } from "./choose-quotes.js";
import { escapeHtml, renderPage, renderPageEnd, renderPageStart, renderStageBlock } from "./page.js";
import { asksSessionBills, sessionMissLine } from "./session-bills.js";
import { closingLine, isSmallTalk, NO_TARGET, paceFor, SPOKEN_REFUSAL, STAGE_LINE } from "./speak.js";

const MAX_BODY = 32 * 1024;

export function coordinatorPayload(comment, urls) {
  return {
    comment: String(comment || "").trim().slice(0, 2000),
    urls: (urls || []).slice(0, 8),
  };
}

function cookieHeader(name, value, maxAge) {
  const base = "HttpOnly; Secure; SameSite=Lax; Path=/forum-ai";
  if (!value) return `${name}=; ${base}; Max-Age=0`;
  return `${name}=${value}; ${base}; Max-Age=${maxAge}`;
}

function htmlHeaders(extra) {
  const headers = new Headers(extra || {});
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set(
    "content-security-policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  return headers;
}

function htmlResponse(body, status, extra) {
  return new Response(body, { status, headers: htmlHeaders(extra) });
}

function presentReply(reply) {
  const fallback = reply?.answer || reply?.refusal || SPOKEN_REFUSAL;
  if (!reply) return { ok: false, answer: SPOKEN_REFUSAL, quotes: [], refused: [], lead: "", pace: "", stages: [], close: SPOKEN_REFUSAL };
  if (Array.isArray(reply.stages) && reply.stages.length) return reply;
  if (!reply.ok) {
    return { ...reply, pace: reply.pace || "", stages: [], close: reply.close || fallback, quotes: reply.quotes || [] };
  }
  const grouped = { bills: [], gov: [], press: [], academia: [] };
  for (const quote of reply.quotes || []) {
    const id = quoteStage(quote.url);
    if (grouped[id]) grouped[id].push(quote);
  }
  const stages = ["bills", "gov", "press", "academia"].filter((id) => grouped[id].length).map((id) => ({
    id,
    line: STAGE_LINE[id],
    quotes: grouped[id],
    empty: "",
  }));
  return { ...reply, stages, close: reply.close || closingLine(reply.quotes) };
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function readBody(request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function readFields(request) {
  const text = await readBody(request);
  if (text === null) return { error: "too large" };
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  const params = new URLSearchParams(text);
  return {
    username: params.get("username") || "",
    password: params.get("password") || "",
    message: params.get("message") || "",
    comment: params.get("comment") || "",
    sources: params.get("sources") || "",
  };
}

function routePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

export class ForumAiSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = routePath(url.pathname);
    const cookies = parseCookies(request.headers.get("cookie"));
    const forum = forumCredential(request);
    let sid = cookies.get("forum_ai_sid");
    if (forum) {
      if (!sid) sid = crypto.randomUUID();
      await this.state.storage.put(`forum:${sid}`, forum.material);
    }
    const adminToken = cookies.get("forum_ai_admin");
    const adminOk = adminToken ? Boolean(await this.state.storage.get(`admin:${adminToken}`)) : false;
    const forumOk = sid ? Boolean(await this.state.storage.get(`forum:${sid}`)) : false;
    const authorized = adminOk || forumOk;
    const kind = adminOk ? "admin" : forumOk ? "forum" : "";
    if (authorized && !sid) sid = crypto.randomUUID();

    if (path === "/forum-ai/admin" && request.method === "POST") {
      return this.login(request);
    }
    if (path === "/forum-ai" && request.method === "GET") {
      const thread = authorized ? await this.loadThread(sid) : [];
      return this.render({ authorized, kind, sid, thread });
    }
    if (path === "/forum-ai" && request.method === "POST") {
      if (!authorized) {
        const wantsJson = (request.headers.get("content-type") || "").includes("application/json");
        if (wantsJson) return jsonResponse({ error: "Forum session required" }, 401);
        return this.render({
          authorized: false,
          kind: "",
          sid,
          error: "Sign in first.",
          status: 401,
        });
      }
      return this.check(request, { authorized, kind, sid });
    }
    return jsonResponse({ error: "not found" }, 404);
  }

  async loadThread(sid) {
    if (!sid) return [];
    const stored = await this.state.storage.get(`thread:${sid}`);
    return Array.isArray(stored) ? stored : [];
  }

  async saveThread(sid, thread) {
    const trimmed = thread.slice(-40);
    if (sid) await this.state.storage.put(`thread:${sid}`, trimmed);
    return trimmed;
  }

  render({ authorized, kind, sid, thread, error, status = 200 }) {
    const headers = new Headers();
    if (sid) headers.append("set-cookie", cookieHeader("forum_ai_sid", sid, 60 * 60 * 12));
    return htmlResponse(renderPage({ authorized, kind, thread, error }), status, headers);
  }

  async login(request) {
    const fields = await readFields(request);
    if (fields.error) return jsonResponse({ error: "too large" }, 413);
    const ok = await adminMatches(fields.username, fields.password, this.env.FORUM_AI_ADMIN_PASSWORD);
    if (!ok) {
      return this.render({
        authorized: false,
        kind: "",
        error: "Admin sign-in failed.",
        status: 401,
      });
    }
    const token = crypto.randomUUID();
    const sid = crypto.randomUUID();
    await this.state.storage.put(`admin:${token}`, Date.now());
    const headers = new Headers();
    headers.append("set-cookie", cookieHeader("forum_ai_admin", token, 60 * 60 * 12));
    headers.append("set-cookie", cookieHeader("forum_ai_sid", sid, 60 * 60 * 12));
    headers.set("location", "/forum-ai");
    headers.set("cache-control", "no-store");
    return new Response(null, { status: 303, headers });
  }

  coordinatorRequest(payload) {
    const ns = this.env.COORDINATOR;
    const stub = ns.get(ns.idFromName("coordinator"));
    return stub.fetch(new Request("https://coordinator/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }));
  }

  failureReply(comment) {
    return {
      ok: false,
      answer: asksSessionBills(comment) ? sessionMissLine() : SPOKEN_REFUSAL,
      quotes: [],
      refused: [],
      lead: "",
      pace: "",
      stages: [],
      close: asksSessionBills(comment) ? sessionMissLine() : SPOKEN_REFUSAL,
    };
  }

  async readCoordinator(res) {
    const type = res.headers.get("content-type") || "";
    if (!type.includes("ndjson")) return res.json();
    const text = await res.text();
    let reply = null;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "done") reply = event.reply;
    }
    return reply;
  }

  rememberTurn(thread, comment, reply) {
    const shown = presentReply(reply);
    thread.push({ role: "user", text: comment.slice(0, 2000) });
    thread.push({
      role: "assistant",
      pace: shown.pace || "",
      stages: shown.stages || [],
      close: shown.ok ? (shown.close || "") : "",
      lead: "",
      text: shown.ok ? "" : (shown.answer || shown.refusal || shown.close || SPOKEN_REFUSAL),
      quotes: shown.ok ? (shown.quotes || []) : [],
      refused: shown.refused || [],
    });
    return shown;
  }

  async check(request, ctx) {
    const fields = await readFields(request);
    if (fields.error) return jsonResponse({ error: "too large" }, 413);
    const wantsJson = (request.headers.get("content-type") || "").includes("application/json");
    const comment = String(fields.message || fields.comment || "").trim();
    if (!comment) {
      if (wantsJson) return jsonResponse({ error: "missing comment" }, 400);
      const thread = await this.loadThread(ctx.sid);
      return this.render({ ...ctx, thread, error: "Write a message.", status: 400 });
    }
    const urls = extractUrls(fields.sources, comment).slice(0, 8);
    if (isSmallTalk(comment, urls)) {
      const thread = await this.loadThread(ctx.sid);
      thread.push({ role: "user", text: comment.slice(0, 2000) });
      thread.push({ role: "assistant", text: NO_TARGET, quotes: [], pace: "", stages: [], close: "", refused: [] });
      const saved = await this.saveThread(ctx.sid, thread);
      if (wantsJson) {
        return jsonResponse({ ok: false, answer: NO_TARGET, quotes: [], refused: [], lead: "", pace: "", stages: [], close: NO_TARGET });
      }
      return this.render({ ...ctx, thread: saved });
    }
    const payload = coordinatorPayload(comment, urls);
    if (!wantsJson) return this.streamCheck(ctx, comment, payload);
    let reply;
    try {
      reply = presentReply(await this.readCoordinator(await this.coordinatorRequest(payload)));
    } catch {
      reply = this.failureReply(comment);
    }
    const thread = await this.loadThread(ctx.sid);
    this.rememberTurn(thread, comment, reply);
    await this.saveThread(ctx.sid, thread);
    return jsonResponse(reply);
  }

  streamCheck(ctx, comment, payload) {
    const pace = paceFor(comment, payload.urls);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start: async (controller) => {
        const send = (html) => controller.enqueue(encoder.encode(html));
        const thread = await this.loadThread(ctx.sid);
        send(renderPageStart({
          authorized: ctx.authorized,
          kind: ctx.kind,
          thread,
          userText: comment.slice(0, 2000),
          pace,
        }));
        let reply;
        try {
          reply = await this.readStages(payload, send);
        } catch {
          reply = this.failureReply(comment);
        }
        const shown = presentReply({ ...reply, pace: reply.pace || pace });
        if (!(reply.stages || []).length) {
          for (const stage of shown.stages || []) send(renderStageBlock(stage));
        }
        const close = shown.ok ? (shown.close || "") : (shown.answer || shown.close || SPOKEN_REFUSAL);
        send(renderPageEnd({ close, refused: shown.refused }));
        this.rememberTurn(thread, comment, { ...shown, pace, close: shown.ok ? shown.close : "" });
        try {
          await this.saveThread(ctx.sid, thread);
        } catch {
          // The page is already on its way.
        }
        controller.close();
      },
    }, new CountQueuingStrategy({ highWaterMark: 32 }));
    const headers = htmlHeaders();
    if (ctx.sid) headers.append("set-cookie", cookieHeader("forum_ai_sid", ctx.sid, 60 * 60 * 12));
    return new Response(stream, { status: 200, headers });
  }

  async readStages(payload, send) {
    const res = await this.coordinatorRequest(payload);
    const type = res.headers.get("content-type") || "";
    if (!type.includes("ndjson") || !res.body) {
      const reply = await res.json();
      return reply;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let reply = null;
    const stages = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.type === "pace" && event.pace) send(`<p>${escapeHtml(event.pace)}</p>`);
        if (event.type === "stage" && event.stage) {
          stages.push(event.stage);
          send(renderStageBlock(event.stage));
        }
        if (event.type === "done" && event.reply) reply = event.reply;
      }
    }
    if (reply) return { ...reply, stages: reply.stages?.length ? reply.stages : stages };
    return { ok: false, answer: SPOKEN_REFUSAL, quotes: [], stages, close: SPOKEN_REFUSAL, refused: [], pace: "" };
  }
}
