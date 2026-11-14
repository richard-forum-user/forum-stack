import { urlAllowed } from "./allowlist.js";
import { isBillDoc, mentionsLd } from "./bill-pages.js";
import { readAllowlisted } from "./read-page.js";
import { isArticleUrl, isPubmedRecord, isScholarSearch } from "./scholar.js";
import { contentTokens, pickSpans } from "./spans.js";

const MAX_FETCH = 8;
const MAX_PDF = 3;

function linkMatches(url, comment, fromUrl) {
  let fromHost = "";
  try {
    fromHost = new URL(fromUrl).hostname.toLowerCase();
  } catch {
    fromHost = "";
  }
  const hay = decodeURIComponent(url).toLowerCase();
  return contentTokens(comment).some((word) => word !== "ld" && !fromHost.includes(word) && hay.includes(word));
}

function hrefOf(link) {
  return typeof link === "string" ? link : link?.url;
}

export async function runAgent({ group, comment, urls, fetchImpl }) {
  const quotes = [];
  const pages = {};
  const queue = [...(urls || [])];
  const seen = new Set();
  let fetches = 0;
  let pdfFetches = 0;
  while (queue.length && fetches < MAX_FETCH) {
    const raw = queue.shift();
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (!urlAllowed(raw, group)) continue;
    if (isBillDoc(raw) && /getpdf/i.test(raw)) {
      if (pdfFetches >= MAX_PDF) continue;
      pdfFetches += 1;
    }
    fetches += 1;
    const read = await readAllowlisted(raw, group, fetchImpl);
    if (!read) continue;
    pages[read.url] = read.text;
    const found = pickSpans(comment, read.text, read.url).filter((quote) => read.text.includes(quote.text));
    for (const quote of found) quotes.push(quote);
    const next = [];
    for (const link of read.links || []) {
      const href = hrefOf(link);
      const label = typeof link === "string" ? "" : link?.text || "";
      if (!href || seen.has(href) || queue.includes(href) || next.includes(href)) continue;
      if (!urlAllowed(href, group)) continue;
      const bill = isBillDoc(href);
      const named = mentionsLd(href, comment) || mentionsLd(label, comment);
      const article = isArticleUrl(href) && !isPubmedRecord(href);
      const scholar = isScholarSearch(href);
      if (bill || named || article || scholar || (!found.length && linkMatches(href, comment, read.url))) next.push(href);
    }
    const docs = next.filter((href) => isBillDoc(href));
    const pdfLinks = docs.filter((href) => /getpdf/i.test(href)).slice(0, MAX_PDF);
    const summary = docs.filter((href) => /summary\.asp|dockets\.asp/i.test(href)).slice(0, 1);
    const articles = next.filter((href) => isArticleUrl(href) && !isPubmedRecord(href)).slice(0, 2);
    const scholar = next.filter((href) => isScholarSearch(href)).slice(0, 2);
    const rest = next.filter((href) => !docs.includes(href) && !articles.includes(href) && !scholar.includes(href));
    queue.unshift(...pdfLinks, ...summary);
    if (articles.length) queue.unshift(...articles);
    else queue.unshift(...scholar);
    queue.push(...rest);
  }
  return { quotes, pages };
}

async function handle(request, group) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const result = await runAgent({ group, comment: body.comment, urls: body.urls });
  return Response.json(result);
}

export class GovSourceAgent {
  constructor(state, env) {
    this.state = state;
    void env;
  }

  fetch(request) {
    return handle(request, "gov");
  }
}

export class AcademiaSourceAgent {
  constructor(state, env) {
    this.state = state;
    void env;
  }

  fetch(request) {
    return handle(request, "academia");
  }
}

export class PressSourceAgent {
  constructor(state, env) {
    this.state = state;
    void env;
  }

  fetch(request) {
    return handle(request, "press");
  }
}
