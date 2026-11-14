import { urlAllowed } from "./allowlist.js";
import { contentTokens } from "./spans.js";

const QUESTION = new Set([
  "tell", "about", "greater", "detail", "what", "experts", "expert", "saying",
  "commentary", "testimony", "please", "more", "explain", "opinion", "opinions",
]);

const TITLE_DROP = new Set([
  "establish", "place", "temporary", "limitation", "certain", "coordination",
  "council", "regarding", "state", "within", "under", "through", "provide",
]);

// Article pages stay article pages when a search link adds ?term=.
export function canonicalArticle(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const pmc = host.endsWith("pmc.ncbi.nlm.nih.gov") && /\/articles\/pmc\d+/i.test(url.pathname);
    const doi = (host === "doi.org" || host.endsWith(".doi.org")) && url.pathname.startsWith("/10.");
    if (!pmc && !doi) return String(raw);
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return String(raw || "");
  }
}

export function isArticleUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (host.endsWith("pubmed.ncbi.nlm.nih.gov") && /^\/\d+\/?$/.test(url.pathname)) return true;
    if (host.endsWith("pmc.ncbi.nlm.nih.gov") && /\/articles\/pmc\d+/i.test(url.pathname)) return true;
    if ((host === "doi.org" || host.endsWith(".doi.org")) && url.pathname.startsWith("/10.")) return true;
  } catch {
    return false;
  }
  return false;
}

export function isPubmedRecord(raw) {
  try {
    const url = new URL(raw);
    return url.hostname.toLowerCase().endsWith("pubmed.ncbi.nlm.nih.gov") && /^\/\d+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function isScholarSearch(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const searchPath = url.pathname.toLowerCase().includes("search");
    if (host.endsWith("pmc.ncbi.nlm.nih.gov")) return searchPath;
    if (host.endsWith("pubmed.ncbi.nlm.nih.gov")) return searchPath || url.searchParams.has("term");
    return false;
  } catch {
    return false;
  }
}

// Keyword query for peer-reviewed search. The whole question is not the query.
export function expertQuery(comment, extra = "") {
  const act = String(extra || "").match(/An Act to ([^.(]{12,140})/i);
  if (act) {
    const words = act[1].toLowerCase().split(/[^a-z]+/).filter(Boolean);
    if (words.includes("data") && words.includes("center")) {
      return { term: '"data centers" OR "data center"', hint: "maine data center data centers" };
    }
    const core = words.filter((word) => word.length > 3 && !TITLE_DROP.has(word));
    const use = (core.length ? core : words).slice(0, 5);
    return { term: use.join(" "), hint: use.join(" ") };
  }
  const ld = String(comment || "").match(/\bLD\s*#?\s*(\d{1,4})\b/i);
  if (ld) {
    const n = String(Number(ld[1]));
    return { term: `Maine LD ${n}`, hint: `maine ld ${n}` };
  }
  const words = contentTokens(comment).filter((word) => !QUESTION.has(word));
  const use = words.slice(0, 6);
  return { term: use.join(" "), hint: use.join(" ") };
}

export function scholarSeeds(term) {
  const q = encodeURIComponent(String(term || "").trim().slice(0, 180));
  if (!q) return [];
  return [
    `https://pubmed.ncbi.nlm.nih.gov/?term=${q}`,
    `https://pmc.ncbi.nlm.nih.gov/search/?term=${q}`,
  ].filter((url) => urlAllowed(url, "academia"));
}
