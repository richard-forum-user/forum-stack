const STOP = new Set([
  "that", "this", "with", "from", "have", "were", "been", "your", "they",
  "their", "about", "which", "what", "when", "where", "will", "would",
  "could", "should", "into", "than", "then", "them", "said", "says",
  "also", "page", "and", "the", "for", "are", "was", "not", "you", "but",
  "its", "it's", "have", "has", "had", "does", "did",
]);

function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3 && !STOP.has(word));
}

export function pickSpans(comment, pageText, url, limit = 3) {
  const text = String(pageText || "");
  const words = tokens(comment);
  if (!words.length || !text) return [];

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 20 && sentence.length <= 500 && text.includes(sentence));

  const ranked = [];
  for (const sentence of sentences) {
    const hay = sentence.toLowerCase();
    let score = 0;
    for (const word of words) if (hay.includes(word)) score += 1;
    if (score > 0) ranked.push({ sentence, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.sentence.length - b.sentence.length);

  const quotes = [];
  const seen = new Set();
  for (const row of ranked) {
    if (quotes.length >= limit) break;
    if (seen.has(row.sentence)) continue;
    seen.add(row.sentence);
    quotes.push({ text: row.sentence, url });
  }
  return quotes;
}
