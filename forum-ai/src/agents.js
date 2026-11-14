import { urlAllowed } from "./allowlist.js";
import { readAllowlisted } from "./read-page.js";
import { contentTokens, pickSpans } from "./spans.js";

const MAX_FETCH = 6;

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

export async function runAgent({ group, comment, urls, fetchImpl }) {
  const quotes = [];
  const pages = {};
  const queue = [...(urls || [])];
  const seen = new Set();
  let fetches = 0;
  while (queue.length && fetches < MAX_FETCH) {
    const raw = queue.shift();
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (!urlAllowed(raw, group)) continue;
    fetches += 1;
    const read = await readAllowlisted(raw, group, fetchImpl);
    if (!read) continue;
    pages[read.url] = read.text;
    const found = pickSpans(comment, read.text, read.url).filter((quote) => read.text.includes(quote.text));
    for (const quote of found) quotes.push(quote);
    if (found.length) continue;
    for (const link of read.links || []) {
      if (seen.has(link) || !linkMatches(link, comment, read.url)) continue;
      queue.push(link);
    }
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
