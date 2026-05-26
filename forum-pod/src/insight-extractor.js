// Deterministic, in-browser extractor for behavioral and psychographic
// signals. No model, no network, no statefulness. Lexicons + regex.
//
// The extractor is intentionally conservative:
//   - It never emits anything when nothing matches.
//   - It always cites which lexicon entry produced each hit (`why`).
//   - The user-declared category from the submission form is the
//     primary truth; this extractor only enriches with attribute
//     specifics, entity strings, and sentiment.
//
// Bump LEXICON_VERSION when you change the contents below.
// `Reprocess` should re-run extract() on raw_submissions whose
// lexicon_version is missing or older than this string.

export const LEXICON_VERSION = "v1";

// ---------- Lexicons ----------

// Behavioral verbs grouped by category. Each group maps a canonical
// action verb to surface forms found in everyday writing.
const BEHAVIORAL_VERBS = {
  purchasing: {
    purchased: ["bought", "purchased", "ordered", "picked up", "got", "snagged", "splurged on"],
  },
  media: {
    watched:   ["watched", "streamed", "binged", "saw", "rewatched"],
    read:      ["read", "finished reading", "skimmed", "browsed"],
    listened:  ["listened to", "played", "queued up"],
  },
  civic: {
    voted:     ["voted for", "voted against", "voted"],
    attended:  ["attended", "showed up to", "went to", "joined the meeting"],
    contacted: ["called", "emailed", "wrote to", "messaged"],
  },
  social: {
    joined:    ["joined", "signed up for", "subscribed to", "became a member of"],
    donated:   ["donated to", "supported", "backed", "chipped in for"],
    met:       ["met with", "hung out with", "caught up with"],
  },
  health: {
    exercised: ["ran", "biked", "lifted", "worked out", "trained", "swam", "hiked"],
    ate:       ["ate", "had", "made", "cooked", "tried"],
    slept:     ["slept", "napped", "rested"],
  },
};

// Psychographic attribute lexicon. Two pattern shapes are allowed:
//   - A bare keyword string.
//   - A composite {all:[...], near:[...]} requiring all of `all` to
//     appear AND at least one of `near` to appear elsewhere in the text.
const PSYCHOGRAPHIC = {
  value: {
    sustainability:       ["recycled", "sustainable", "eco", "organic", "carbon", "ethical", "fair trade", "compostable"],
    family:               ["family", "kids", "parent", "spouse", "my wife", "my husband", "my partner"],
    health_wellness:      ["healthy", "wellness", "nutrition", "self-care"],
    spirituality:         ["faith", "prayer", "meditation", "spiritual", "mindful"],
    community:            ["neighbors", "local", "community", "co-op", "mutual aid"],
    independence:         ["self-reliant", "off-grid", "diy", "do it myself"],
  },
  interest: {
    outdoors:             ["hiking", "camping", "trail", "mountain", "kayak", "backpack", "rei"],
    cooking:              ["recipe", "kitchen", "baking", "sourdough", "cast iron", "knife skills"],
    gaming:               ["console", "steam", "rpg", "raid", "esports", "switch", "playstation"],
    reading:              ["novel", "book", "chapter", "kindle"],
    fitness:              ["gym", "workout", "lift", "squat", "deadlift", "yoga", "marathon"],
    music:                ["concert", "album", "vinyl", "playlist", "festival"],
    tech_tinkering:       ["raspberry pi", "homelab", "self-hosted", "kernel", "compile"],
    politics:             ["candidate", "ballot", "campaign", "policy"],
  },
  lifestyle: {
    minimalism:           ["declutter", "minimal", "less stuff"],
    urban:                ["downtown", "transit", "subway", "walkable", "apartment"],
    rural:                ["acreage", "homestead", "farm", "pasture", "barn"],
    frugal:               ["sale", "coupon", "discount", "thrift", "secondhand"],
    early_adopter:        ["beta", "preorder", "early access", "launch day"],
  },
  attitude: {
    premium_for_ethics:   [{ all: ["expensive"], near: ["love", "worth it", "recycled", "ethical", "fair trade"] }],
    skeptical:            ["skeptical", "doubt", "scam", "snake oil", "hype"],
    enthusiastic:         ["obsessed", "in love", "can't stop", "blown away"],
    cautious:             ["careful", "wait and see", "not sure"],
  },
};

// Sentiment lexicon. Very small on purpose; do not try to outsmart
// VADER here. Just enough to color rows.
const SENTIMENT = {
  pos: ["love", "loved", "great", "amazing", "happy", "excited", "worth it", "fantastic", "thrilled", "delighted"],
  neg: ["hate", "hated", "terrible", "awful", "frustrated", "waste", "disappointing", "regret", "annoyed", "angry"],
};

// Negation window: if any of these tokens appear within N tokens
// before a sentiment word, flip the sign of that sentiment.
const NEGATIONS = ["not", "no", "never", "don't", "didn't", "doesn't", "wasn't", "isn't"];
const NEGATION_WINDOW = 3;

// ---------- Helpers ----------

function tokenize(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9']+/g) || [];
}

function containsPhrase(haystack, needle) {
  if (!needle) return false;
  return haystack.includes(needle.toLowerCase());
}

function matchPattern(text, pattern) {
  if (typeof pattern === "string") {
    return containsPhrase(text, pattern) ? [pattern] : [];
  }
  if (pattern && pattern.all && pattern.near) {
    const allHit = pattern.all.every((w) => containsPhrase(text, w));
    const nearHit = pattern.near.some((w) => containsPhrase(text, w));
    return allHit && nearHit
      ? [pattern.all.concat(pattern.near.filter((w) => containsPhrase(text, w))).join("+")]
      : [];
  }
  return [];
}

function extractEntity(rawText, verbPhrase) {
  const re = new RegExp(
    `\\b${verbPhrase.replace(/[-/\\^$*+?.()|[\\]{}]/g, "\\$&")}\\b\\s+(?:a |an |the |some |my |new )?([\\w][\\w &'\\-]{1,60})`,
    "i"
  );
  const m = rawText.match(re);
  if (!m) return null;
  const tail = m[1].trim().split(/[.,!?;\n]/)[0];
  return tail.replace(/\s{2,}/g, " ").trim();
}

function scoreSentiment(text) {
  const tokens = tokenize(text);
  let score = 0;
  let hits = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const isPos = SENTIMENT.pos.includes(tok);
    const isNeg = SENTIMENT.neg.includes(tok);
    if (!isPos && !isNeg) continue;
    let polarity = isPos ? 1 : -1;
    for (let j = Math.max(0, i - NEGATION_WINDOW); j < i; j++) {
      if (NEGATIONS.includes(tokens[j])) {
        polarity *= -1;
        break;
      }
    }
    score += polarity;
    hits += 1;
  }
  if (!hits) return 0;
  return Math.max(-1, Math.min(1, score / Math.max(2, hits)));
}

// ---------- Public API ----------

export function extractInsights(rawText) {
  const text = String(rawText || "");
  const lower = text.toLowerCase();
  const behaviors = [];
  const psychographics = [];

  // Behavioral verbs -> action + best-effort entity
  for (const [category, verbs] of Object.entries(BEHAVIORAL_VERBS)) {
    for (const [action, phrases] of Object.entries(verbs)) {
      for (const phrase of phrases) {
        if (!containsPhrase(lower, phrase)) continue;
        const entity = extractEntity(text, phrase);
        behaviors.push({
          category,
          action,
          entity,
          source: `rule:${LEXICON_VERSION}`,
          confidence: entity ? 0.65 : 0.5,
          why: { matched_phrase: phrase },
        });
        break;
      }
    }
  }

  // Psychographic attributes
  for (const [category, attrs] of Object.entries(PSYCHOGRAPHIC)) {
    for (const [attribute, patterns] of Object.entries(attrs)) {
      const hits = patterns.flatMap((p) => matchPattern(lower, p));
      if (!hits.length) continue;
      const confidence = Math.min(0.95, 0.45 + 0.12 * hits.length);
      psychographics.push({
        category,
        attribute,
        sentiment: scoreSentiment(text),
        source: `rule:${LEXICON_VERSION}`,
        confidence,
        why: { matched: hits },
      });
    }
  }

  return {
    behaviors,
    psychographics,
    lexicon_version: LEXICON_VERSION,
  };
}

// Parse `#tag` style hashtags out of free text into psychographic rows
// at full user-declared confidence.
export function extractUserTags(rawText) {
  const text = String(rawText || "");
  const tags = Array.from(text.matchAll(/#([a-z][a-z0-9_-]{1,40})/gi)).map((m) => m[1].toLowerCase());
  return tags.map((tag) => ({
    category: "tag",
    attribute: tag,
    sentiment: 0,
    source: "user",
    confidence: 1.0,
    why: { matched: [`#${tag}`] },
  }));
}
