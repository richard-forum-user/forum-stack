// Phrase marker. Runs only for a single-proposal thread. Phrases come from
// thread_config.stance_phrases. Oppose is checked first, then support.

export function normalizeStanceText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/['’]/g, "");
}

export function markStance(text, threadConfig) {
  if (!threadConfig || threadConfig.mode !== "single_proposal") return null;
  const phrases = threadConfig.stance_phrases || {};
  const norm = normalizeStanceText(text);
  for (const phrase of phrases.oppose || []) {
    if (phrase && norm.includes(normalizeStanceText(phrase))) return "oppose";
  }
  for (const phrase of phrases.support || []) {
    if (phrase && norm.includes(normalizeStanceText(phrase))) return "support";
  }
  return "unclear";
}
