// Placement is pure code. It matches build_fixture.py: circles_for, bucket_for,
// then one region per author (union of that author's comments).

export function circlesFor(themes, circles) {
  const out = [];
  for (const [key, cfg] of Object.entries(circles)) {
    const list = cfg.themes || [];
    if ((themes || []).some((t) => list.includes(t))) out.push(key);
  }
  return out;
}

export function bucketFor(themes, tone, opposes, config) {
  if (circlesFor(themes, config.circles).length) return null;
  const process = new Set(config.process_themes || []);
  if ((themes || []).some((t) => process.has(t))) return "process";
  if (tone === "off_topic") return "off_topic";
  if (opposes && opposes.length) return "pushback_only";
  return "venting";
}

export function placeAuthors(comments, config) {
  const order = Object.keys(config.circles);
  const prefs = config.outside_buckets || ["process", "pushback_only", "venting", "off_topic"];
  const by = new Map();
  for (const c of comments) {
    const circles = circlesFor(c.themes || [], config.circles);
    const bucket = bucketFor(c.themes || [], c.tone, c.opposes || [], config);
    if (!by.has(c.author)) by.set(c.author, []);
    by.get(c.author).push({ circles, bucket });
  }
  const placement = {};
  for (const [author, rows] of by) {
    const circ = [...new Set(rows.flatMap((r) => r.circles))].sort(
      (a, b) => order.indexOf(a) - order.indexOf(b),
    );
    if (circ.length) {
      placement[author] = circ.join("+");
    } else {
      const buckets = rows.map((r) => r.bucket);
      for (const pref of prefs) {
        if (buckets.includes(pref)) {
          placement[author] = "outside:" + pref;
          break;
        }
      }
    }
  }
  return placement;
}

export function countRegions(placement) {
  const counts = {};
  for (const region of Object.values(placement)) {
    counts[region] = (counts[region] || 0) + 1;
  }
  return counts;
}

export function regionKey(region) {
  if (!region) return region;
  return region.startsWith("outside:") ? region.slice("outside:".length) : region;
}

export function authorCircles(region) {
  if (!region || region.startsWith("outside:")) return [];
  return region.split("+");
}
