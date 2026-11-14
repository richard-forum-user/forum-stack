import { adminMatches, forumCredential, parseCookies } from "./auth.js";
import { extractUrls } from "./allowlist.js";
import { renderPage } from "./page.js";
import { REFUSAL } from "./quote-check.js";

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

function htmlResponse(body, status, extra) {
  const headers = new Headers(extra || {});
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
  return new Response(body, { status, headers });
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
    const payload = coordinatorPayload(comment, urls);
    let reply;
    try {
      const ns = this.env.COORDINATOR;
      const stub = ns.get(ns.idFromName("coordinator"));
      const outbound = new Request("https://coordinator/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const res = await stub.fetch(outbound);
      reply = await res.json();
    } catch {
      reply = { ok: false, answer: REFUSAL, quotes: [], refused: [] };
    }
    const thread = await this.loadThread(ctx.sid);
    thread.push({ role: "user", text: comment.slice(0, 2000) });
    thread.push({
      role: "assistant",
      text: reply.ok ? "" : (reply.answer || reply.refusal || REFUSAL),
      quotes: reply.ok ? (reply.quotes || []) : [],
      refused: reply.refused || [],
    });
    const saved = await this.saveThread(ctx.sid, thread);
    if (wantsJson) return jsonResponse(reply);
    return this.render({ ...ctx, thread: saved });
  }
}
