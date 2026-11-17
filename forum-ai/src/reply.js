import { urlAllowed } from "./allowlist.js";

export const REPLY_PROMPT = [
  "Answer in a few normal sentences.",
  "You may paraphrase the page.",
  "Include every URL you were given, exactly as written.",
  "Do not refuse because a sentence is not a word-for-word quote.",
].join(" ");

export function usedLinks(requested, pages) {
  const urls = [];
  const add = (url) => {
    const raw = String(url || "");
    if (!raw || urls.includes(raw) || !urlAllowed(raw)) return;
    urls.push(raw);
  };
  for (const url of requested || []) add(url);
  for (const url of Object.keys(pages || {})) add(url);
  return urls;
}

export function pageNotes(urls, pages) {
  const chunks = [];
  for (const url of urls || []) {
    const text = String(pages?.[url] || "").replace(/\s+/g, " ").trim().slice(0, 3500);
    chunks.push(text ? `URL: ${url}\n${text}` : `URL: ${url}\n(no page text)`);
  }
  return chunks.join("\n\n").slice(0, 8000);
}

export function withUsedLink(answer, urls) {
  let text = String(answer || "").replace(/\s+/g, " ").trim();
  const missing = (urls || []).filter((url) => url && !text.includes(url));
  if (!text && missing.length) return `I read the page at ${missing.join(" ")}.`;
  if (!text) return "I can talk about a bill, a vote, or a news story.";
  if (!missing.length) return text;
  return `${text} The page is at ${missing.join(" ")}.`;
}
