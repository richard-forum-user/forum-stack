import { groupOf } from "./allowlist.js";
import { checkQuotes } from "./quote-check.js";
import { chooseQuotes, hasExpertQuote } from "./choose-quotes.js";
import { searchSeeds } from "./search-seeds.js";
import { SPOKEN_REFUSAL, statusLine } from "./speak.js";

const BINDING = { gov: "GOV", academia: "ACADEMIA", press: "PRESS" };

export function assembleReply(results, comment) {
  const chosen = chooseQuotes(comment, results);
  const quotes = chosen.quotes;
  const pages = chosen.pages;
  if (!quotes.length) {
    return { ok: false, refusal: SPOKEN_REFUSAL, answer: SPOKEN_REFUSAL, quotes: [], lead: "" };
  }
  const answer = quotes.map((quote) => `"${quote.text}"`).join(" and ");
  const verdict = checkQuotes({ answer, quotes, pages });
  if (!verdict.ok) {
    return { ok: false, refusal: SPOKEN_REFUSAL, answer: SPOKEN_REFUSAL, quotes: [], errors: verdict.errors, lead: "" };
  }
  return {
    ok: true,
    answer,
    quotes,
    lead: statusLine(comment, quotes, hasExpertQuote(quotes)),
    sources: [...new Set(quotes.map((quote) => quote.url))],
  };
}

// Fans a check out to the three source agents. This function does not fetch.
export async function runCoordinator({ comment, urls, ask }) {
  const pasted = Array.isArray(urls) ? urls : [];
  const planned = pasted.length ? pasted : searchSeeds(comment);
  const buckets = { gov: [], academia: [], press: [] };
  const refused = [];
  const seen = new Set();
  for (const raw of planned) {
    if (seen.has(raw)) continue;
    seen.add(raw);
    const group = groupOf(raw);
    if (!group) {
      refused.push(raw);
      continue;
    }
    buckets[group].push(raw);
  }

  const groups = ["gov", "academia", "press"].filter((group) => buckets[group].length);
  const asked = groups.map((group) => ask(group, {
    comment: String(comment || "").slice(0, 2000),
    urls: buckets[group],
  }));
  const results = (await Promise.all(asked)).map((result) => result || { quotes: [], pages: {} });

  return { ...assembleReply(results, comment), refused };
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
