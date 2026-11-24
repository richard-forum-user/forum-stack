// Extraction schema from the opinion-map spec. Unknown top-level fields fail
// the extraction. A claim whose span is not an exact substring is dropped.

export const TONES = ["constructive", "venting", "attack", "sarcasm", "meta", "off_topic"];
export const CLAIM_KINDS = ["fact", "prediction", "personal"];
const ALLOWED = new Set([
  "themes",
  "new_theme_suggestions",
  "opposes",
  "claims",
  "tone",
  "specificity",
]);

function wordLimit(label, n) {
  return String(label || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, n)
    .join(" ");
}

export function parseModelJson(text) {
  if (text && typeof text === "object") return { ok: true, value: text };
  let raw = String(text || "").trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  if (!raw) return { ok: false, error: "empty" };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return { ok: true, value: JSON.parse(raw.slice(start, end + 1)) };
      } catch (err) {
        return { ok: false, error: String(err.message || err) };
      }
    }
    return { ok: false, error: "not_json" };
  }
}

export function validateExtraction(raw, commentText, themeIds) {
  const errors = [];
  const droppedClaims = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["not_object"], value: null, droppedClaims };
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED.has(key)) errors.push("unknown_field:" + key);
  }
  if (errors.some((e) => e.startsWith("unknown_field:"))) {
    return { ok: false, errors, value: null, droppedClaims };
  }

  const themes = [];
  const suggestions = [];
  for (const item of Array.isArray(raw.new_theme_suggestions) ? raw.new_theme_suggestions : []) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    suggestions.push({ id, label: wordLimit(item.label || id, 6) });
  }
  for (const id of Array.isArray(raw.themes) ? raw.themes : []) {
    if (typeof id !== "string" || !themeIds.has(id)) {
      if (typeof id === "string" && id.trim()) {
        suggestions.push({ id: id.trim(), label: wordLimit(id.trim().replace(/_/g, " "), 6) });
      } else {
        errors.push("bad_theme");
      }
      continue;
    }
    if (!themes.includes(id)) themes.push(id);
  }

  const opposes = [];
  for (const id of Array.isArray(raw.opposes) ? raw.opposes : []) {
    if (typeof id === "string" && themeIds.has(id)) {
      if (!opposes.includes(id)) opposes.push(id);
    } else {
      errors.push("bad_oppose");
    }
  }

  const claims = [];
  for (const item of Array.isArray(raw.claims) ? raw.claims : []) {
    const span = item && typeof item.span === "string" ? item.span : "";
    const kind = item && item.kind;
    if (!CLAIM_KINDS.includes(kind)) {
      errors.push("bad_kind");
      continue;
    }
    if (!span || !commentText.includes(span)) {
      droppedClaims.push({ span, kind });
      errors.push("bad_span");
      continue;
    }
    claims.push({ span, kind });
  }

  const tone = TONES.includes(raw.tone) ? raw.tone : null;
  if (!tone) errors.push("bad_tone");
  const specificity = [0, 1, 2].includes(raw.specificity) ? raw.specificity : null;
  if (specificity === null) errors.push("bad_specificity");

  const schemaFail = !tone || specificity === null;
  if (schemaFail) {
    return { ok: false, errors, value: null, droppedClaims };
  }
  return {
    ok: true,
    errors,
    droppedClaims,
    value: {
      themes,
      new_theme_suggestions: suggestions,
      opposes,
      claims,
      tone,
      specificity,
    },
  };
}

export function themeIdSet(config) {
  const ids = new Set();
  for (const cfg of Object.values(config.circles || {})) {
    for (const id of cfg.themes || []) ids.add(id);
  }
  for (const id of config.process_themes || []) ids.add(id);
  for (const id of config.unplaced_themes || []) ids.add(id);
  return ids;
}
