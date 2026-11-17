import { contentTokens } from "./spans.js";
import { asksSessionBills } from "./session-bills.js";

export const SPOKEN_REFUSAL = "I looked at the allowlisted pages and did not find that.";
export const EXPERT_ABSENT = "Expert commentary was not on an allowlisted page.";
export const PACING_LINE = "That will take a moment. I'll check the bill list first, then other .gov pages, then the press pages, starting with AP.";
export const PACING_NAMED = "That will take a moment. I'll check the pages you named.";
export const PACING_SECONDARY = "That will take a moment. I'll check other .gov pages, then the press pages, starting with AP.";
export const NO_TARGET = "I can quote an allowlisted page. Ask about a bill, or paste a link.";

export const STAGE_LINE = {
  bills: "Bill list checked.",
  gov: "Other .gov pages checked.",
  press: "Press pages checked.",
  academia: "Journal pages checked.",
};

export const STAGE_EMPTY = {
  bills: "No matching line on the bill list.",
  gov: "No matching line on the other .gov pages.",
  press: "No matching line on the press pages.",
  academia: EXPERT_ABSENT,
};

export function asksExperts(comment) {
  return /\b(experts?|commentary|saying|testimony)\b/i.test(String(comment || ""));
}

// A greeting with nothing to look up. A bill, a session question, an expert
// question, or a pasted link is a real check.
export function isSmallTalk(comment, urls) {
  const text = String(comment || "").trim();
  if (!text) return false;
  if ((urls || []).some(Boolean)) return false;
  if (/\bLD\s*#?\s*\d{1,4}\b/i.test(text)) return false;
  if (asksSessionBills(text)) return false;
  if (asksExperts(text)) return false;
  return contentTokens(text).length < 2;
}

export function paceFor(comment, urls) {
  const pasted = (urls || []).filter(Boolean);
  if (pasted.length) return PACING_NAMED;
  return "That will take a moment.";
}

export function closingLine(quotes) {
  const hosts = [];
  for (const quote of quotes || []) {
    let host = "";
    try {
      host = new URL(quote.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host || hosts.includes(host)) continue;
    hosts.push(host);
    if (hosts.length === 3) break;
  }
  if (!hosts.length) return "I won't guess.";
  const named = hosts.length === 1
    ? hosts[0]
    : hosts.length === 2
      ? `${hosts[0]} and ${hosts[1]}`
      : `${hosts[0]}, ${hosts[1]}, and ${hosts[2]}`;
  return `These lines are on ${named}, and I won't guess.`;
}

export function lookingLine(urls) {
  const hosts = [];
  for (const raw of urls || []) {
    let host = "";
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host || hosts.includes(host)) continue;
    hosts.push(host);
    if (hosts.length === 3) break;
  }
  if (hosts.length === 0) return "";
  if (hosts.length === 1) return `Looking at ${hosts[0]}`;
  if (hosts.length === 2) return `Looking at ${hosts[0]} and ${hosts[1]}`;
  return `Looking at ${hosts[0]}, ${hosts[1]}, and ${hosts[2]}`;
}

export function statusLine(comment, quotes, expertsFound) {
  const line = lookingLine((quotes || []).map((quote) => quote.url));
  if (!line || !asksExperts(comment) || expertsFound) return line;
  return `${line}. ${EXPERT_ABSENT}`;
}
