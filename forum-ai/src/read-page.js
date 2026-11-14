import { urlAllowed } from "./allowlist.js";

const SKIP_LINK = /\.(pdf|png|jpe?g|gif|css|js|ico|svg|zip|xml)(\?|$)/i;

export function linksIn(html, base, group) {
  const out = [];
  const seen = new Set();
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
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
    out.push(abs);
    if (out.length === 20) break;
  }
  return out;
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

// Returns page text only after the host allowlist accepts the URL. Redirects
// are manual so an off-list Location is never requested.
export async function readAllowlisted(raw, group, fetchImpl = globalThis.fetch) {
  let current = String(raw || "");
  const seen = new Set();
  for (let hop = 0; hop < 3; hop++) {
    if (seen.has(current)) return null;
    seen.add(current);
    if (!urlAllowed(current, group)) return null;
    const response = await fetchImpl(current, {
      redirect: "manual",
      headers: {
        accept: "text/html, text/plain",
        "user-agent": "forum-ai",
      },
    });
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
    if (type && !/text\/html|text\/plain|application\/xhtml/i.test(type)) {
      await dropBody(response);
      return null;
    }
    const html = await response.text();
    const text = htmlToText(html).slice(0, 20000);
    if (!text) return null;
    return { url: finalUrl, text, links: linksIn(html, finalUrl, group) };
  }
  return null;
}
