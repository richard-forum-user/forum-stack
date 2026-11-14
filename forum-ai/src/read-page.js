import { urlAllowed } from "./allowlist.js";
import { isBillDoc } from "./bill-pages.js";
import { pdfToText } from "./pdf-text.js";
import { canonicalArticle, isArticleUrl, isPubmedRecord } from "./scholar.js";

const SKIP_LINK = /\.(pdf|png|jpe?g|gif|css|js|ico|svg|zip|xml)(\?|$)/i;

export function linksIn(html, base, group) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*\shref\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || "")))) {
    let abs;
    try {
      abs = new URL(match[1], base).href.split("#")[0];
    } catch {
      continue;
    }
    let path = "";
    try {
      path = new URL(abs).pathname;
    } catch {
      continue;
    }
    if (SKIP_LINK.test(path)) continue;
    if (!urlAllowed(abs, group)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    const text = match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    out.push({ url: abs, text, doc: isBillDoc(abs) });
  }
  const articles = out.filter((link) => isArticleUrl(link.url) && !isPubmedRecord(link.url));
  const records = out.filter((link) => isPubmedRecord(link.url));
  const docs = out.filter((link) => link.doc && !articles.includes(link));
  const rest = out.filter((link) => !link.doc && !articles.includes(link) && !records.includes(link));
  return [...articles.map((link) => link.url), ...titleSearches(html, base, group), ...records.map((link) => link.url), ...docs.map((link) => link.url), ...rest.map((link) => link.url)].slice(0, 12);
}

function plainLabel(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// PubMed result titles become PMC searches, because the article page itself
// is a cookie wall and the PMC copy is readable HTML.
function titleSearches(html, base, group) {
  let host = "";
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return [];
  }
  if (!host.endsWith("pubmed.ncbi.nlm.nih.gov")) return [];
  const titles = [];
  const re = /class="docsum-title"[\s\S]*?>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || "")))) {
    const title = plainLabel(match[1]);
    if (title.length < 30) continue;
    titles.push(title);
  }
  let phrases = [];
  try {
    phrases = [...new URL(base).searchParams.get("term").matchAll(/"([^"]{8,80})"/g)].map((item) => item[1].toLowerCase());
  } catch {
    phrases = [];
  }
  const hit = (title) => phrases.find((phrase) => title.toLowerCase().includes(phrase));
  const phrased = phrases.length ? titles.filter((title) => hit(title)) : [];
  const rank = (title) => {
    const phrase = hit(title);
    return (phrase ? phrase.length * 20 : 0) + title.length;
  };
  const ranked = (phrased.length ? phrased : titles).sort((a, b) => rank(b) - rank(a));
  const found = [];
  for (const title of ranked) {
    const url = `https://pmc.ncbi.nlm.nih.gov/search/?term=${encodeURIComponent(title.slice(0, 180))}`;
    if (!urlAllowed(url, group) || found.includes(url)) continue;
    found.push(url);
    if (found.length === 2) break;
  }
  return found;
}

export function htmlToText(html) {
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

async function dropBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The status is already known.
  }
}

const remembered = new Map();
const REMEMBER_MS = 10 * 60 * 1000;

function recall(url) {
  const hit = remembered.get(url);
  if (!hit || Date.now() - hit.at > REMEMBER_MS) return null;
  return hit.value;
}

function remember(url, value) {
  remembered.set(url, { at: Date.now(), value });
  if (remembered.size > 40) remembered.delete(remembered.keys().next().value);
}

// Returns page text only after the host allowlist accepts the URL. Redirects
// are manual so an off-list Location is never requested. A page read in the
// last few minutes is reused when the live fetch fails.
export async function readAllowlisted(raw, group, fetchImpl = globalThis.fetch) {
  const read = await fetchAllowlisted(raw, group, fetchImpl);
  if (fetchImpl === globalThis.fetch && read) {
    remember(canonicalArticle(raw), read);
    remember(canonicalArticle(read.url), read);
  }
  if (read) return read;
  if (fetchImpl !== globalThis.fetch) return null;
  return recall(canonicalArticle(raw));
}

async function fetchAllowlisted(raw, group, fetchImpl) {
  let current = String(raw || "");
  const seen = new Set();
  for (let hop = 0; hop < 3; hop++) {
    if (seen.has(current)) return null;
    seen.add(current);
    if (!urlAllowed(current, group)) return null;
    let response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: {
          accept: "text/html, text/plain, application/pdf",
          "user-agent": "forum-ai",
        },
      });
    } catch {
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get("location");
      await dropBody(response);
      if (!loc) return null;
      try {
        current = new URL(loc, current).href;
      } catch {
        return null;
      }
      continue;
    }
    if (!response.ok) {
      await dropBody(response);
      return null;
    }
    const finalUrl = response.url || current;
    if (!urlAllowed(finalUrl, group)) {
      await dropBody(response);
      return null;
    }
    const type = response.headers.get("content-type") || "";
    const bytes = new Uint8Array(await response.arrayBuffer());
    const isPdf = /pdf/i.test(type) || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
    if (isPdf) {
      const text = (await pdfToText(bytes)).slice(0, 20000);
      if (!text) return null;
      return { url: finalUrl, text, links: [] };
    }
    if (type && !/text\/html|text\/plain|application\/xhtml/i.test(type)) return null;
    const html = new TextDecoder().decode(bytes);
    const text = htmlToText(html).slice(0, 20000);
    if (!text || /cookies must be enabled/i.test(text)) return null;
    return { url: finalUrl, text, links: linksIn(html, finalUrl, group) };
  }
  return null;
}
