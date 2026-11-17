import { urlAllowed } from "./allowlist.js";
import { asksSessionBills, SESSION_LIST_URL } from "./session-bills.js";

const MAX_SEEDS = 12;

function push(seeds, url) {
  if (seeds.length >= MAX_SEEDS) return;
  if (!urlAllowed(url) || seeds.includes(url)) return;
  seeds.push(url);
}

function pressSeeds(seeds, q) {
  push(seeds, `https://apnews.com/search?q=${q}`);
  push(seeds, `https://www.reuters.com/search/news?blob=${q}`);
  push(seeds, `https://www.npr.org/search?query=${q}`);
  push(seeds, `https://www.bbc.com/search?q=${q}`);
  push(seeds, `https://www.pbs.org/search/?q=${q}`);
}

// Allowlisted pages, split so the bill list, other .gov pages, and the press
// pages can each use their own fetch budget. AP is the first press page.
export function stageSeeds(comment) {
  const text = String(comment || "").trim();
  const bills = [];
  const gov = [];
  const press = [];
  const academia = [];
  if (!text) return { bills, gov, press, academia };
  const q = encodeURIComponent(text.slice(0, 160));
  const ld = text.match(/\bLD\s*#?\s*(\d{1,4})\b/i);
  if (asksSessionBills(text)) {
    push(bills, SESSION_LIST_URL);
    push(gov, `https://www.maine.gov/search?q=${q}`);
  } else if (ld) {
    const n = String(Number(ld[1]));
    push(bills, `https://legislature.maine.gov/legis/bills/display_ps.asp?LD=${n}&snum=132`);
    push(gov, `https://www.maine.gov/search?q=${encodeURIComponent(`LD ${n}`)}`);
    push(gov, `https://legiscan.com/ME/bill/LD${n}/2025`);
  } else {
    push(gov, `https://www.maine.gov/search?q=${q}`);
  }
  pressSeeds(press, q);
  if (!asksSessionBills(text)) {
    push(academia, `https://pubmed.ncbi.nlm.nih.gov/?term=${q}`);
    push(academia, `https://pmc.ncbi.nlm.nih.gov/search/?term=${q}`);
  }
  return { bills, gov, press, academia };
}

export function searchSeeds(comment) {
  const stages = stageSeeds(comment);
  return [...stages.bills, ...stages.gov, ...stages.press, ...stages.academia];
}
