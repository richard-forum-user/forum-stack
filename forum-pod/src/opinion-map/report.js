import { authorCircles, countRegions, regionKey } from "./place.js";

export function countMap(pairs) {
  const counts = {};
  for (const id of pairs) counts[id] = (counts[id] || 0) + 1;
  return counts;
}

export function themeAuthors(comments) {
  const byAuthor = new Map();
  for (const c of comments) {
    if (!byAuthor.has(c.author)) byAuthor.set(c.author, new Set());
    for (const t of c.themes || []) byAuthor.get(c.author).add(t);
  }
  const counts = {};
  for (const themes of byAuthor.values()) {
    for (const t of themes) counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

export function opposeAuthors(comments) {
  const byAuthor = new Map();
  for (const c of comments) {
    if (!byAuthor.has(c.author)) byAuthor.set(c.author, new Set());
    for (const t of c.opposes || []) byAuthor.get(c.author).add(t);
  }
  const counts = {};
  for (const themes of byAuthor.values()) {
    for (const t of themes) counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}

export function themesInRegion(comments, placement, region) {
  const authors = new Set(Object.entries(placement).filter(([, r]) => r === region).map(([a]) => a));
  const counts = {};
  const seen = new Map();
  for (const c of comments) {
    if (!authors.has(c.author)) continue;
    if (!seen.has(c.author)) seen.set(c.author, new Set());
    for (const t of c.themes || []) seen.get(c.author).add(t);
  }
  for (const themes of seen.values()) {
    for (const t of themes) counts[t] = (counts[t] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function commonGround(comments, placement) {
  const authorsByTheme = new Map();
  for (const c of comments) {
    for (const t of c.themes || []) {
      if (!authorsByTheme.has(t)) authorsByTheme.set(t, new Set());
      authorsByTheme.get(t).add(c.author);
    }
  }
  const rows = [];
  for (const [theme, authors] of authorsByTheme) {
    const circles = new Set();
    for (const author of authors) {
      for (const circle of authorCircles(placement[author])) circles.add(circle);
    }
    if (circles.size >= 2) rows.push({ theme, authors: authors.size, circles: [...circles] });
  }
  rows.sort((a, b) => b.authors - a.authors || a.theme.localeCompare(b.theme));
  return rows;
}

export function buildFacts({ comments, placement, failures, labels }) {
  const authors = new Set(comments.map((c) => c.author));
  const tones = {};
  for (const c of comments) tones[c.tone] = (tones[c.tone] || 0) + 1;
  const themeCounts = themeAuthors(comments);
  const opposeCounts = opposeAuthors(comments);
  const regions = countRegions(placement);
  const perRegion = {};
  for (const region of Object.keys(regions)) {
    perRegion[region] = themesInRegion(comments, placement, region).slice(0, 3).map(([theme, n]) => ({
      theme,
      label: labels[theme] || theme,
      authors: n,
    }));
  }
  return {
    n_comments: comments.length,
    n_authors: authors.size,
    extraction_failures: failures || 0,
    region_counts: regions,
    theme_author_counts: themeCounts,
    tone_comment_counts: tones,
    pushback: {
      second_home_tax: { for: themeCounts.second_home_tax || 0, against: opposeCounts.second_home_tax || 0 },
      new_taxes: { against: opposeCounts.new_taxes || 0 },
    },
    per_region: perRegion,
    common_ground: commonGround(comments, placement).slice(0, 6),
    frustration: { venting: tones.venting || 0, attack: tones.attack || 0 },
  };
}

function regionPhrase(region, labelsForCircles) {
  if (!region) return "an unplaced group";
  if (region.startsWith("outside:")) return "the " + regionKey(region).replace(/_/g, " ") + " group, outside the circles";
  const parts = region.split("+").map((id) => labelsForCircles[id] || id);
  return parts.join(" and ");
}

export function renderReport(facts, circleLabels) {
  const lines = ["## What people argued", ""];
  lines.push(facts.n_comments + " comments from " + facts.n_authors + " people.");
  lines.push(facts.extraction_failures + " comments could not be read.");
  lines.push("");
  lines.push("### People in each region");
  const regions = Object.entries(facts.region_counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [region, n] of regions) {
    lines.push(n + " people are in " + regionPhrase(region, circleLabels) + ".");
    for (const theme of facts.per_region[region] || []) {
      lines.push("- " + theme.label + ": " + theme.authors + " people");
    }
  }
  if (!facts.region_counts["CUT+REV"]) {
    lines.push("0 people are in both cut spending and raise revenue only.");
  }
  lines.push("");
  lines.push("### Pushback");
  const sh = facts.pushback.second_home_tax;
  lines.push("second-home tax: " + sh.for + " for, " + sh.against + " against");
  lines.push("new taxes opposed by " + facts.pushback.new_taxes.against + " authors");
  lines.push("");
  lines.push("### Frustration");
  lines.push(facts.frustration.venting + " comments are venting. " + facts.frustration.attack + " comments are attacks.");
  lines.push("");
  lines.push("### Claims");
  lines.push("Fact claims are checked against an official source. Nothing is shown as true without a .gov or LegiScan quote.");
  return lines.join("\n");
}

export function allowedSummaryNumbers(facts) {
  const allowed = new Set();
  const add = (n) => {
    if (typeof n === "number" && Number.isFinite(n)) allowed.add(n);
  };
  add(facts.n_comments);
  add(facts.n_authors);
  add(facts.extraction_failures);
  for (const n of Object.values(facts.region_counts || {})) add(n);
  for (const n of Object.values(facts.theme_author_counts || {})) add(n);
  for (const n of Object.values(facts.tone_comment_counts || {})) add(n);
  add(facts.pushback?.second_home_tax?.for);
  add(facts.pushback?.second_home_tax?.against);
  add(facts.pushback?.new_taxes?.against);
  add(facts.frustration?.venting);
  add(facts.frustration?.attack);
  for (const row of facts.common_ground || []) add(row.authors);
  return allowed;
}

export function guardSummary(summary, facts, verbatimFlag) {
  if (!summary || typeof summary !== "string") return null;
  if (verbatimFlag !== "1" && /R\d{3}/.test(summary)) return null;
  const allowed = allowedSummaryNumbers(facts);
  const nums = summary.match(/\d+/g) || [];
  for (const raw of nums) {
    if (!allowed.has(Number(raw))) return null;
  }
  return summary;
}

export function circleDisplayLabels(config) {
  const out = {};
  for (const [id, cfg] of Object.entries(config.circles || {})) {
    out[id] = shortWords(String(cfg.label || id).split("(")[0], 5);
  }
  return out;
}

export function shortWords(text, n) {
  const words = String(text || "")
    .replace(/[()/]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words.slice(0, n).join(" ");
}
