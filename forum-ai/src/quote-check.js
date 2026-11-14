// Quote gate. The idea is ported from forum-pod/src/civic-referee/check-reply.js:
// a reply fails when it cites a host outside the allowlist, states a figure
// that is not inside a quote, writes a vote tally, or cites a simulated seat.
// This slice also requires every quote to be an exact substring of a fetched
// page. Words outside the quotes may only be connectives.

import { urlAllowed } from "./allowlist.js";

export const REFUSAL = "These sources do not contain that answer.";

const CONNECTIVES = new Set(["and", "or", "which", "says", "say", "also", "the", "page", "a", "an"]);
const TALLY = /\b\d[\d,]*\s*(?:for|against|agree|agrees|disagree|disagrees)\b|\b(?:for|against|agree|agrees|disagree|disagrees)\s*\d[\d,]*\b|\bdid not vote\b/i;
const SEAT = /\bdc307-\d+\b|\bseat\s+\d+\b|\bsimulated seat\b/i;
const NUMBER_RE = /\b\d[\d,]*(?:\.\d+)?%?\b/;
const MIN_SPAN = 20;

function bridgeText(answer, quotes) {
  let rest = String(answer || "");
  const parts = quotes
    .map((quote) => String(quote?.text || ""))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const text of parts) rest = rest.split(text).join(" ");
  return rest.replace(/["“”«»]/g, " ");
}

export function checkQuotes({ answer, quotes, pages }) {
  const list = Array.isArray(quotes) ? quotes : [];
  if (list.length === 0) {
    return { ok: false, refusal: REFUSAL, errors: ["no matching quote"] };
  }

  const errors = [];
  for (const quote of list) {
    const text = String(quote?.text || "");
    const url = String(quote?.url || "");
    if (text.trim().length < MIN_SPAN) errors.push("no matching quote");
    if (!urlAllowed(url)) errors.push(`off-list host: ${url}`);
    const page = pages?.[url];
    if (typeof page !== "string" || !page.includes(text)) errors.push("paraphrase");
  }

  const bridge = bridgeText(answer, list);
  const words = bridge.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
  for (const word of words) {
    if (!CONNECTIVES.has(word)) errors.push(`non-connective: ${word}`);
  }
  if (NUMBER_RE.test(bridge)) errors.push("figure outside a quote");
  if (TALLY.test(bridge)) errors.push("writes a vote tally");
  if (SEAT.test(bridge)) errors.push("cites a simulated seat");

  if (errors.length) return { ok: false, refusal: REFUSAL, errors };
  return { ok: true, errors: [] };
}
