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

// Prefer a legislature document over search-page chrome and older sessions.
export function chooseQuotes(comment, results) {
  const pages = {};
  const quotes = [];
  for (const result of results || []) {
    for (const [url, text] of Object.entries(result?.pages || {})) pages[url] = text;
    for (const quote of result?.quotes || []) quotes.push(quote);
  }
  const cleaned = quotes.filter((quote) => usable(quote, pages, comment));
  const ld = String(comment || "").match(/\bLD\s*#?\s*(\d{1,4})\b/i);
  if (ld) {
    const n = String(Number(ld[1]));
    const current = cleaned.filter((quote) => {
      try {
        const url = new URL(quote.url);
        return url.hostname === "legislature.maine.gov"
          && url.searchParams.get("LD") === n
          && url.searchParams.get("snum") === "132";
      } catch {
        return false;
      }
    });
    if (current.length) return { quotes: current.slice(0, 2), pages };
  }
  const documents = cleaned.filter((quote) => !searchUrl(quote.url));
  return { quotes: (documents.length ? documents : []).slice(0, 3), pages };
}
