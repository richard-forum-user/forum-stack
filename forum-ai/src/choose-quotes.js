import { hostGroup } from "./allowlist.js";
import { isBillDoc } from "./bill-pages.js";

const CHROME = [
  "search terms",
  "saved search",
  "skip to main content",
  "clipboard",
  "need a paper copy",
  "printed document pdf",
  "official websites use",
];

function searchUrl(raw) {
  try {
    const url = new URL(raw);
    const path = url.pathname.toLowerCase();
    if (path.includes("search")) return true;
    return url.searchParams.has("term") || url.searchParams.has("q") || url.searchParams.has("query");
  } catch {
    return false;
  }
}

function usable(quote, pages, comment) {
  const text = String(quote?.text || "");
  const url = String(quote?.url || "");
  const page = pages?.[url];
  if (!text || typeof page !== "string" || !page.includes(text)) return false;
  const hay = text.toLowerCase();
  if (CHROME.some((mark) => hay.includes(mark))) return false;
  const asked = String(comment || "").trim().toLowerCase();
  if (asked.length >= 8 && hay.includes(asked) && searchUrl(url)) return false;
  return true;
}

function olderSession(url) {
  try {
    return new URL(url).searchParams.get("snum") === "131";
  } catch {
    return false;
  }
}

function legislaturePage(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "legislature.maine.gov" || host === "www.mainelegislature.org" || isBillDoc(url);
  } catch {
    return false;
  }
}

function scoreQuote(quote, comment) {
  const hay = String(quote.text || "").toLowerCase();
  let score = 0;
  const ld = String(comment || "").match(/\bLD\s*#?\s*(\d{1,4})\b/i);
  if (ld && hay.includes(String(Number(ld[1])))) score += 4;
  if (/^(an act |this bill |sec\. \d|be it enacted|final disposition|this bill, having)/i.test(hay.trim())) score += 3;
  if (/\b(notwithstanding|may not|shall provide)\b/.test(hay)) score += 3;
  if (hay.includes("printed on recycled") || hay.includes("reproduced and distributed")) score -= 4;
  return score;
}

function diversify(quotes, limit) {
  const byUrl = new Map();
  for (const quote of quotes) {
    const list = byUrl.get(quote.url) || [];
    list.push(quote);
    byUrl.set(quote.url, list);
  }
  const picked = [];
  const take = (quote) => {
    if (picked.length >= limit) return;
    if (picked.some((kept) => kept.text.includes(quote.text) || quote.text.includes(kept.text))) return;
    picked.push(quote);
  };
  for (const list of byUrl.values()) take(list[0]);
  for (const list of byUrl.values()) {
    for (const quote of list.slice(1)) take(quote);
  }
  return picked;
}

// Keep several exact bill-text quotes, plus other allowlisted documents.
// Search pages that only echo the question are left out.
export function chooseQuotes(comment, results) {
  const pages = {};
  const quotes = [];
  for (const result of results || []) {
    for (const [url, text] of Object.entries(result?.pages || {})) pages[url] = text;
    for (const quote of result?.quotes || []) quotes.push(quote);
  }
  let cleaned = quotes.filter((quote) => usable(quote, pages, comment) && !searchUrl(quote.url));
  const ld = String(comment || "").match(/\bLD\s*#?\s*(\d{1,4})\b/i);
  if (ld) {
    const hasCurrent = cleaned.some((quote) => {
      try {
        const url = new URL(quote.url);
        return url.searchParams.get("snum") === "132" || /getpdf/i.test(url.pathname) || isBillDoc(quote.url);
      } catch {
        return false;
      }
    });
    if (hasCurrent) cleaned = cleaned.filter((quote) => !olderSession(quote.url));
  }
  cleaned.sort((a, b) => scoreQuote(b, comment) - scoreQuote(a, comment));
  const bill = cleaned.filter((quote) => legislaturePage(quote.url));
  const other = cleaned.filter((quote) => !legislaturePage(quote.url));
  const picked = [...diversify(bill, 5), ...diversify(other, 2)].slice(0, 6);
  return { quotes: picked, pages };
}

export function hasExpertQuote(quotes) {
  return (quotes || []).some((quote) => {
    try {
      const group = hostGroup(new URL(quote.url).hostname);
      return group === "academia" || group === "press";
    } catch {
      return false;
    }
  });
}
