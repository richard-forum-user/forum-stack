// Shared by the Civic AI referee and the harness. A reply fails when it
// cites anything outside .gov and LegiScan, states a figure that is not
// inside a quote tied to one of those sources, writes a vote tally, or
// cites a simulated seat.

const TALLY = /\b\d[\d,]*\s*(?:for|against|agree|agrees|disagree|disagrees)\b|\b(?:for|against|agree|agrees|disagree|disagrees)\s*\d[\d,]*\b|\bdid not vote\b/i;
const SEAT = /\bdc307-\d+\b|\bseat\s+\d+\b|\bsimulated seat\b/i;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const NUMBER_RE = /\b\d[\d,]*(?:\.\d+)?%?\b/;

export function sourceHostAllowed(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (host === "legiscan.com" || host.endsWith(".legiscan.com")) return true;
  if (host === "gov" || host.endsWith(".gov")) return true;
  return false;
}

export function urlAllowed(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    return sourceHostAllowed(url.hostname);
  } catch {
    return false;
  }
}

function urlsIn(text) {
  URL_RE.lastIndex = 0;
  return String(text || "").match(URL_RE) || [];
}

function bareAnswer(answer) {
  return String(answer || "")
    .replace(/"[^"]*"/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/'[^']*'/g, " ");
}

export function checkReply(reply) {
  const errors = [];
  const answer = String(reply?.answer || "");
  const quotes = Array.isArray(reply?.quotes) ? reply.quotes : [];
  const sources = Array.isArray(reply?.sources) ? reply.sources : [];
  const model = String(reply?.model || "");
  const time = String(reply?.time || "");
  if (!model) errors.push("missing model id");
  if (!time) errors.push("missing time");

  const visible = [
    answer,
    ...quotes.map((quote) => `${quote?.text || ""} ${quote?.url || ""}`),
    ...sources,
  ].join("\n");

  for (const raw of urlsIn(visible)) {
    const cleaned = raw.replace(/[.,;]+$/, "");
    if (!urlAllowed(cleaned)) errors.push(`source outside .gov and LegiScan: ${cleaned}`);
  }
  for (const source of sources) {
    if (!urlAllowed(source)) errors.push(`source outside .gov and LegiScan: ${source}`);
  }
  for (const quote of quotes) {
    if (quote?.url && !urlAllowed(quote.url)) {
      errors.push(`source outside .gov and LegiScan: ${quote.url}`);
    }
  }

  if (TALLY.test(visible)) errors.push("writes a vote tally");
  if (SEAT.test(visible)) errors.push("cites a simulated seat");

  if (NUMBER_RE.test(bareAnswer(answer))) errors.push("figure with no quoted source");
  for (const quote of quotes) {
    const text = String(quote?.text || "");
    if (NUMBER_RE.test(text) && !urlAllowed(quote?.url)) errors.push("figure with no quoted source");
  }

  return { ok: errors.length === 0, errors };
}
