// Host allowlists for the three source groups. A URL is refused before any
// fetch when its host is not in the group that would open it.

const PRESS_HOSTS = ["apnews.com", "reuters.com", "npr.org", "bbc.com", "pbs.org"];
const ACADEMIA_HOSTS = ["doi.org", "pubmed.ncbi.nlm.nih.gov", "pmc.ncbi.nlm.nih.gov"];

export function normalizeHost(hostname) {
  return String(hostname || "").toLowerCase().replace(/\.$/, "");
}

function hostIs(host, name) {
  return host === name || host.endsWith(`.${name}`);
}

export function hostGroup(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return null;
  // PubMed and PMC are .gov hosts that belong to the academia agent.
  for (const name of ACADEMIA_HOSTS) {
    if (hostIs(host, name)) return "academia";
  }
  for (const name of PRESS_HOSTS) {
    if (hostIs(host, name)) return "press";
  }
  if (host === "legiscan.com" || host.endsWith(".legiscan.com")) return "gov";
  if (host === "gov" || host.endsWith(".gov")) return "gov";
  return null;
}

export function urlAllowed(raw, group) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const found = hostGroup(url.hostname);
  if (!found) return false;
  if (group && found !== group) return false;
  return true;
}

export function groupOf(raw) {
  if (!urlAllowed(raw)) return null;
  try {
    return hostGroup(new URL(raw).hostname);
  } catch {
    return null;
  }
}

export function extractUrls(...blobs) {
  const seen = new Set();
  const out = [];
  for (const blob of blobs) {
    for (const line of String(blob || "").split(/\s+/)) {
      const cleaned = line.replace(/[.,;)]+$/, "");
      if (!cleaned.startsWith("https://")) continue;
      if (seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}
