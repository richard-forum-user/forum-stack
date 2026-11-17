import { urlAllowed } from "./allowlist.js";

// The bills search lists the sessions. It is the page to open when no quote matches.
export const SESSION_LIST_URL = "https://legislature.maine.gov/bills/default_ps.asp";

export function sessionMissLine() {
  return `I can't answer that without leaving the quoted sources. The session list is at ${SESSION_LIST_URL}.`;
}

// A question about what is filed for the current or next session, with no LD number.
export function asksSessionBills(comment) {
  const text = String(comment || "");
  if (/\bLD\s*#?\s*\d{1,4}\b/i.test(text)) return false;
  if (/\bnext session\b/i.test(text)) return true;
  return /\b(legislation|bills?|measures)\b/i.test(text) && /\b(session|coming|upcoming|filed|next)\b/i.test(text);
}

// Maine legislation with no bill number uses the legislature bill list.
// A numbered LD stays on that bill's page. congress.gov is not a Maine page.
export function asksMaineBills(comment) {
  if (asksSessionBills(comment)) return true;
  const text = String(comment || "");
  if (/\bLD\s*#?\s*\d{1,4}\b/i.test(text)) return false;
  return /\bmaine\b/i.test(text);
}

// Session numbers printed on the bills search or a directory heading.
// The page's own list decides which sessions to open.
export function sessionNumbers(text) {
  const found = new Set();
  const blob = String(text || "");
  const listed = blob.match(/Session Any((?:\s+\d{3}){1,40})/);
  if (listed) {
    for (const n of listed[1].match(/\d{3}/g) || []) {
      const value = Number(n);
      if (value >= 100 && value <= 200) found.add(value);
    }
  }
  for (const match of blob.matchAll(/\b(\d{2,3})\s*(?:st|nd|rd|th)\s+Maine Legislature\b/gi)) {
    const value = Number(match[1]);
    if (value >= 100 && value <= 200) found.add(value);
  }
  return [...found].sort((a, b) => b - a);
}

export function billDirectoryUrl(snum) {
  const n = String(Number(snum));
  if (!/^\d{3}$/.test(n)) return "";
  const url = `https://legislature.maine.gov/bills/billdirectory_ps.asp?ldFrom=1&snum=${n}`;
  return urlAllowed(url, "gov") ? url : "";
}

export function billDisplayLinks(text, limit = 3) {
  const links = [];
  const re = /LD (\d+), ([A-Z]{1,4}) (\d+), (\d{2,3})(?:st|nd|rd|th) Legislature (An Act|Resolve)\b/g;
  const rows = [];
  let match;
  while ((match = re.exec(String(text || "")))) rows.push(match);
  rows.sort((a, b) => Number(b[5] === "An Act") - Number(a[5] === "An Act") || Number(a[1]) - Number(b[1]));
  for (const row of rows) {
    const paper = `${row[2]}${row[3].padStart(4, "0")}`;
    const url = `https://legislature.maine.gov/bills/display_ps.asp?snum=${row[4]}&paper=${paper}&PID=1456`;
    if (!urlAllowed(url, "gov") || links.includes(url)) continue;
    links.push(url);
    if (links.length >= limit) break;
  }
  return links;
}

function pushQuote(quotes, text, slice, url, min) {
  const raw = String(slice || "").replace(/\s+/g, " ").trim();
  if (raw.length < min || raw.length > 320) return;
  if (!text.includes(raw)) return;
  if (quotes.some((quote) => quote.text === raw || quote.text.includes(raw) || raw.includes(quote.text))) return;
  quotes.push({ text: raw, url });
}

// Exact directory and bill-page lines: the session heading, a not-yet-printed
// notice, and filed bill titles. Nothing is added that the page did not print.
export function pickBillQuotes(pageText, url) {
  const text = String(pageText || "");
  const quotes = [];
  const heading = text.match(/\d{2,3}\s*(?:st|nd|rd|th)\s+Maine Legislature\b/i);
  if (heading) pushQuote(quotes, text, heading[0], url, 20);
  const missing = text.match(/Legislative documents from \d+ to \d+ are not available at this time\./i);
  if (missing) pushQuote(quotes, text, missing[0], url, 40);

  const acts = [];
  const row = /LD \d+, [A-Z]{1,4} \d+, \d{2,3}(?:st|nd|rd|th) Legislature (?:An Act|Resolve) .{12,220}?(?= Bill &| Printed | \d+\. LD |$)/g;
  const titled = /LD #\s*\d+\s+(?:An Act|Resolve)\s+.{20,220}?(?=\s+Text and\b|\s+Amendments\b|$)/g;
  let match;
  while ((match = row.exec(text))) acts.push(match[0].trim());
  while ((match = titled.exec(text))) acts.push(match[0].trim());
  acts.sort((a, b) => Number(/\bAn Act\b/.test(b)) - Number(/\bAn Act\b/.test(a)));
  for (const slice of acts) {
    if (quotes.filter((quote) => /\b(An Act|Resolve)\b/.test(quote.text)).length >= 4) break;
    pushQuote(quotes, text, slice, url, 40);
  }
  return quotes;
}
