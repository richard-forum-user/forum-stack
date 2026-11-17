import { urlAllowed } from "./allowlist.js";
import { asksSessionBills, SESSION_LIST_URL } from "./session-bills.js";
import { asksExperts } from "./speak.js";

export const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct";

export const VAGUE_PAGE = "https://www.congress.gov/";

// The model may name only one of these. Anything else is ignored.
export const CHOOSABLE_HOSTS = [
  "congress.gov",
  "legislature.maine.gov",
  "www.maine.gov",
  "legiscan.com",
  "pubmed.ncbi.nlm.nih.gov",
  "pmc.ncbi.nlm.nih.gov",
  "doi.org",
  "apnews.com",
  "reuters.com",
  "npr.org",
  "bbc.com",
  "pbs.org",
];

export const HOST_PROMPT = [
  "Choose the one allowlisted host to open for the question.",
  "Reply with only the host, or none.",
  `Hosts: ${CHOOSABLE_HOSTS.join(", ")}.`,
  "A United States Senate or Congress question uses congress.gov.",
  "A Maine question uses legislature.maine.gov.",
  "Do not add facts.",
].join(" ");

const JOURNAL_HOSTS = new Set(["pubmed.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov", "doi.org"]);
const PRESS_HOSTS = new Set(["apnews.com", "reuters.com", "npr.org", "bbc.com", "pbs.org"]);

export function isVague(comment) {
  return /^\s*what is this\s*\??\s*$/i.test(String(comment || ""));
}

export function pageRefusal(url = VAGUE_PAGE) {
  return `I can't answer that without leaving the quoted sources. The page is at ${url}.`;
}

export function asksMaine(comment) {
  const text = String(comment || "");
  return /\bmaine\b/i.test(text) || /\bLD\s*#?\s*\d{1,4}\b/i.test(text);
}

export function asksCongress(comment) {
  if (asksMaine(comment)) return false;
  return /\b(senate|congress|congressional)\b/i.test(String(comment || ""));
}

export function parseHost(modelText) {
  const hay = String(modelText || "").toLowerCase();
  if (!hay.trim()) return "";
  const ranked = [...CHOOSABLE_HOSTS].sort((a, b) => b.length - a.length);
  for (const host of ranked) {
    if (hay.includes(host)) return host;
  }
  return "";
}

function queryOf(comment) {
  return encodeURIComponent(String(comment || "").trim().slice(0, 160));
}

export function hostUrl(host, comment) {
  const text = String(comment || "");
  const q = queryOf(text);
  const ld = text.match(/\bLD\s*#?\s*(\d{1,4})\b/i);
  const n = ld ? String(Number(ld[1])) : "";
  let url = "";
  if (host === "congress.gov") url = `https://www.congress.gov/search?q=${q}`;
  else if (host === "legislature.maine.gov") {
    if (!asksMaine(text)) url = "";
    else if (n && !asksSessionBills(text)) url = `https://legislature.maine.gov/legis/bills/display_ps.asp?LD=${n}&snum=132`;
    else url = SESSION_LIST_URL;
  } else if (host === "www.maine.gov") {
    url = asksMaine(text) ? `https://www.maine.gov/search?q=${q}` : "";
  } else if (host === "legiscan.com") {
    url = n
      ? `https://legiscan.com/ME/bill/LD${n}/2025`
      : `https://legiscan.com/gaits/search?keyword=${q}`;
  } else if (host === "pubmed.ncbi.nlm.nih.gov") url = `https://pubmed.ncbi.nlm.nih.gov/?term=${q}`;
  else if (host === "pmc.ncbi.nlm.nih.gov") url = `https://pmc.ncbi.nlm.nih.gov/search/?term=${q}`;
  else if (host === "doi.org") {
    const doi = text.match(/\b(10\.\d{4,9}\/[^\s]+)/);
    url = doi ? `https://doi.org/${doi[1].replace(/[.,)]+$/, "")}` : "";
  } else if (host === "apnews.com") url = `https://apnews.com/search?q=${q}`;
  else if (host === "reuters.com") url = `https://www.reuters.com/search/news?blob=${q}`;
  else if (host === "npr.org") url = `https://www.npr.org/search?query=${q}`;
  else if (host === "bbc.com") url = `https://www.bbc.com/search?q=${q}`;
  else if (host === "pbs.org") url = `https://www.pbs.org/search/?q=${q}`;
  if (!url || !urlAllowed(url)) return "";
  return url;
}

// The model names one host. congress.gov is only for a US Congress or Senate
// question. A Maine question opens the Maine legislature even if the model
// names congress.gov or no host.
export function resolveHost(comment, modelText) {
  if (isVague(comment)) return "";
  if (asksCongress(comment)) return "congress.gov";
  const picked = parseHost(modelText);
  if (asksExperts(comment) && (JOURNAL_HOSTS.has(picked) || PRESS_HOSTS.has(picked))) return picked;
  if (asksMaine(comment)) return "legislature.maine.gov";
  if (!picked || !CHOOSABLE_HOSTS.includes(picked)) return "";
  if (picked === "congress.gov" || picked === "legislature.maine.gov" || picked === "www.maine.gov") return "";
  return picked;
}

export function modelText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  if (typeof result.response === "string") return result.response;
  if (typeof result.result === "string") return result.result;
  if (typeof result.result?.response === "string") return result.result.response;
  return "";
}

export async function chooseHost(comment, model) {
  if (isVague(comment)) return { host: "", url: "", calls: 0 };
  let raw = "";
  let calls = 0;
  if (typeof model === "function") {
    try {
      raw = modelText(await model(comment));
      calls = 1;
    } catch {
      raw = "";
      calls = 1;
    }
  }
  const host = resolveHost(comment, raw);
  return { host, url: host ? hostUrl(host, comment) : "", calls };
}
