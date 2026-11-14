export const SPOKEN_REFUSAL = "I looked at the allowlisted pages and did not find that.";
export const EXPERT_ABSENT = "Expert commentary was not on an allowlisted page.";

export function asksExperts(comment) {
  return /\b(experts?|commentary|saying|testimony)\b/i.test(String(comment || ""));
}

export function lookingLine(urls) {
  const hosts = [];
  for (const raw of urls || []) {
    let host = "";
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host || hosts.includes(host)) continue;
    hosts.push(host);
    if (hosts.length === 3) break;
  }
  if (hosts.length === 0) return "";
  if (hosts.length === 1) return `Looking at ${hosts[0]}`;
  if (hosts.length === 2) return `Looking at ${hosts[0]} and ${hosts[1]}`;
  return `Looking at ${hosts[0]}, ${hosts[1]}, and ${hosts[2]}`;
}

export function statusLine(comment, quotes, expertsFound) {
  const line = lookingLine((quotes || []).map((quote) => quote.url));
  if (!line || !asksExperts(comment) || expertsFound) return line;
  return `${line}. ${EXPERT_ABSENT}`;
}
