export const SPOKEN_REFUSAL = "I looked at the allowlisted pages and did not find that.";

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
