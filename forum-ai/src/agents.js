import { urlAllowed } from "./allowlist.js";
import { readAllowlisted } from "./read-page.js";
import { pickSpans } from "./spans.js";

export async function runAgent({ group, comment, urls, fetchImpl }) {
  const quotes = [];
  const pages = {};
  for (const raw of urls || []) {
    if (!urlAllowed(raw, group)) continue;
    const read = await readAllowlisted(raw, group, fetchImpl);
    if (!read) continue;
    pages[read.url] = read.text;
    for (const quote of pickSpans(comment, read.text, read.url)) {
      if (read.text.includes(quote.text)) quotes.push(quote);
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
