const STOP = new Set([
  "that", "this", "with", "from", "have", "were", "been", "your", "they",
  "their", "about", "which", "what", "when", "where", "will", "would",
  "could", "should", "into", "than", "then", "them", "said", "says",
  "also", "page", "and", "the", "for", "are", "was", "not", "you", "but",
  "its", "it's", "have", "has", "had", "does", "did",
]);

const NAV = ["skip navigation", "javascript", "site map", "disclaimer", "webmaster"];
const LOW = ["printed on recycled", "reproduced and distributed", "printed document", "fiscal note", "fiscal status"];

export function contentTokens(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => (word.length > 3 || /^\d{2,4}$/.test(word)) && !STOP.has(word));
}

function windowAt(text, at, n) {
  const left = Math.max(0, at - 80);
  let start = left;
  const punct = Math.max(text.lastIndexOf(". ", at), text.lastIndexOf("! ", at), text.lastIndexOf("? ", at));
  if (punct >= left) start = punct + 2;
  while (start < at && text[start] === " ") start += 1;
  if (start > 0 && text[start - 1] !== " ") {
    const sp = text.indexOf(" ", start);
    if (sp !== -1 && sp < at) start = sp + 1;
  }
  let end = Math.min(text.length, at + n + 180);
  const rest = text.slice(at + n, end);
  const rel = rest.search(/[.!?](\s|$)/);
  if (rel >= 0) end = at + n + rel + 1;
  if (end - start > 320) {
    end = start + 320;
    const sp = text.lastIndexOf(" ", end);
    if (sp > at + n) end = sp;
  }
  const raw = text.slice(start, end).trim();
  if (raw.length < 20 || raw.length > 500 || !text.includes(raw)) return "";
  return raw;
}

function sentenceFrom(text, at) {
  let search = at;
  let end = -1;
  while (search < at + 420) {
    const dot = text.indexOf(". ", search);
    if (dot < 0 || dot > at + 400) break;
    const head = text.slice(at, dot).trim();
    if (head.length >= 24 && !/^sec\.?\s*\d*$/i.test(head)) {
      end = dot;
      break;
    }
    search = dot + 2;
  }
  if (end < 0) end = Math.min(text.length, at + 280);
  if (end - at < 110) {
    const next = text.indexOf(". ", end + 2);
    if (next > end && next < at + 520) end = next;
    else {
      const sp = text.lastIndexOf(" ", at + 280);
      if (sp > end) end = sp;
    }
  }
  if (end < text.length && text[end] === ".") end += 1;
  if (end - at > 340) {
    const sp = text.lastIndexOf(" ", at + 320);
    end = sp > at + 40 ? sp : at + 320;
  }
  const raw = text.slice(at, end).trim();
  if (raw.length < 20 || raw.length > 500 || !text.includes(raw)) return "";
  return raw;
}

function scoreSpan(span, words) {
  const hay = span.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (!hay.includes(word)) continue;
    score += /^\d+$/.test(word) ? 4 : 2;
  }
  if (/^(an act |this bill |sec\. \d|be it enacted|final disposition|this bill, having)/i.test(span)) score += 8;
  if (/\b(notwithstanding|may not|shall provide)\b/i.test(span)) score += 3;
  if (NAV.some((mark) => hay.includes(mark))) score -= 8;
  if (LOW.some((mark) => hay.includes(mark))) score -= 6;
  if (/page \d+ -/.test(hay)) score -= 8;
  if (hay.includes("text and disposition") || hay.includes("bill directory") || hay.includes("chamber status")) score -= 8;
  return score;
}

export function pickSpans(comment, pageText, url, limit = 3) {
  const text = String(pageText || "");
  const words = contentTokens(comment);
  if (!words.length || !text) return [];

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 20 && sentence.length <= 500 && text.includes(sentence));
  const windows = [];
  const lower = text.toLowerCase();
  for (const word of words) {
    let from = 0;
    for (let n = 0; n < 6; n += 1) {
      const at = lower.indexOf(word, from);
      if (at < 0) break;
      const slice = windowAt(text, at, word.length);
      if (slice) windows.push(slice);
      from = at + word.length;
    }
  }
  const act = text.match(/LD # \d{1,4} An Act to .{20,180}?\(TITLE CHANGE\)/);
  if (act && text.includes(act[0])) windows.push(act[0]);
  const ld = String(comment || "").match(/\bLD\s*#?\s*(\d{1,4})\b/i);
  const ldNo = ld ? String(Number(ld[1])) : "";
  const pageMentions = ldNo && new RegExp(`\\b(?:LD|L\\.D\\.|No\\.)\\s*#?\\s*0*${ldNo}\\b`, "i").test(text);
  if (pageMentions) {
    for (const marker of ["Be it enacted", "An Act to", "An Act", "This bill", "Sec. 1", "Sec. 3", "Final Disposition", "This Bill, having"]) {
      const at = text.indexOf(marker);
      if (at < 0) continue;
      const slice = sentenceFrom(text, at);
      if (slice) windows.push(slice);
    }
  }

  const ranked = [];
  const seenSpan = new Set();
  for (const sentence of [...sentences, ...windows]) {
    if (seenSpan.has(sentence)) continue;
    seenSpan.add(sentence);
    const score = scoreSpan(sentence, words);
    if (score > 0) ranked.push({ sentence, score });
  }
  const clean = ranked.filter((row) => !NAV.some((mark) => row.sentence.toLowerCase().includes(mark)));
  const pool = clean.length ? clean : ranked;
  pool.sort((a, b) => b.score - a.score || b.sentence.length - a.sentence.length);

  const quotes = [];
  for (const row of pool) {
    if (quotes.length >= limit) break;
    if (row.score < 4 || row.sentence.length < 40) continue;
    if (quotes.some((quote) => quote.text.includes(row.sentence) || row.sentence.includes(quote.text))) continue;
    quotes.push({ text: row.sentence, url });
  }
  return quotes;
}
