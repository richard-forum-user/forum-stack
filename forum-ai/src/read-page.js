import { urlAllowed } from "./allowlist.js";
import { isBillDoc } from "./bill-pages.js";
import { pdfToText } from "./pdf-text.js";

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
  const docs = out.filter((link) => link.doc);
  const rest = out.filter((link) => !link.doc);
  return [...docs, ...rest].slice(0, 16);
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
    if (!text) return null;
    return { url: finalUrl, text, links: linksIn(html, finalUrl, group) };
  }
  return null;
}
