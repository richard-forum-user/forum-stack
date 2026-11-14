import { urlAllowed } from "./allowlist.js";

const MAX_SEEDS = 8;

function push(seeds, url) {
  if (seeds.length >= MAX_SEEDS) return;
  if (!urlAllowed(url) || seeds.includes(url)) return;
  seeds.push(url);
}

// Allowlisted pages to open when the message has no pasted link.
// LD bills start at legislature.maine.gov, then www.maine.gov.
export function searchSeeds(comment) {
  const text = String(comment || "").trim();
  if (!text) return [];
  const q = encodeURIComponent(text.slice(0, 160));
  const seeds = [];
  const ld = text.match(/\bLD\s*#?\s*(\d{1,4})\b/i);
  if (ld) {
    const n = String(Number(ld[1]));
    push(seeds, `https://legislature.maine.gov/legis/bills/display_ps.asp?LD=${n}&snum=132`);
    push(seeds, `https://legislature.maine.gov/legis/bills/display_ps.asp?LD=${n}&snum=131`);
    push(seeds, `https://www.maine.gov/search?q=${encodeURIComponent(`LD ${n}`)}`);
    push(seeds, `https://legiscan.com/ME/bill/LD${n}/2025`);
  } else {
    push(seeds, `https://www.maine.gov/search?q=${q}`);
  }
  push(seeds, `https://pubmed.ncbi.nlm.nih.gov/?term=${q}`);
  push(seeds, `https://pmc.ncbi.nlm.nih.gov/search/?term=${q}`);
  push(seeds, `https://apnews.com/search?q=${q}`);
  push(seeds, `https://www.reuters.com/search/news?blob=${q}`);
  push(seeds, `https://www.npr.org/search?query=${q}`);
  push(seeds, `https://www.bbc.com/search?q=${q}`);
  push(seeds, `https://www.pbs.org/search/?q=${q}`);
  return seeds;
}
