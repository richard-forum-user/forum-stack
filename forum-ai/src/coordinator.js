import { groupOf } from "./allowlist.js";
import { checkQuotes, REFUSAL } from "./quote-check.js";

const BINDING = { gov: "GOV", academia: "ACADEMIA", press: "PRESS" };

export function assembleReply(results) {
  const quotes = [];
  const pages = {};
  for (const result of results || []) {
    for (const [url, text] of Object.entries(result?.pages || {})) pages[url] = text;
    for (const quote of result?.quotes || []) quotes.push(quote);
  }
  if (!quotes.length) {
    return { ok: false, refusal: REFUSAL, answer: REFUSAL, quotes: [] };
  }
  const answer = quotes.map((quote) => `"${quote.text}"`).join(" and ");
  const verdict = checkQuotes({ answer, quotes, pages });
  if (!verdict.ok) {
    return { ok: false, refusal: verdict.refusal, answer: verdict.refusal, quotes: [], errors: verdict.errors };
  }
  return {
    ok: true,
    answer,
    quotes,
    sources: [...new Set(quotes.map((quote) => quote.url))],
  };
}

// Fans a check out to the three source agents. This function does not fetch.
export async function runCoordinator({ comment, urls, ask }) {
  const buckets = { gov: [], academia: [], press: [] };
  const refused = [];
  const seen = new Set();
  for (const raw of urls || []) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const group = groupOf(raw);
    if (!group) {
      refused.push(raw);
      continue;
    }
    buckets[group].push(raw);
  }

  const results = [];
  for (const group of ["gov", "academia", "press"]) {
    if (!buckets[group].length) continue;
    const result = await ask(group, {
      comment: String(comment || "").slice(0, 2000),
      urls: buckets[group],
    });
    results.push(result || { quotes: [], pages: {} });
  }

  return { ...assembleReply(results), refused };
}

export class ForumAiCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const body = await request.json();
    const reply = await runCoordinator({
      comment: body.comment,
      urls: body.urls,
      ask: async (group, payload) => {
        const ns = this.env[BINDING[group]];
        const stub = ns.get(ns.idFromName(group));
        const res = await stub.fetch("https://agent/check", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        return res.json();
      },
    });
    return Response.json(reply);
  }
}
