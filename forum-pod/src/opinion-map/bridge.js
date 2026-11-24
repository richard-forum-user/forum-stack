// Bridge drafts are not public until a steward approves them.

export function wordCount(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export function bridgePrompt(facts, labels) {
  const lines = [
    "Draft 3 to 5 short neutral statements a town could vote on.",
    "Each statement is 15 words or fewer.",
    "Use only the theme labels below. Do not name a person. Do not quote a comment. Do not invent a number.",
    "Return JSON only: {\"statements\":[\"...\"]}",
    "",
    "Themes that show up across more than one circle:",
  ];
  for (const row of facts.common_ground || []) {
    lines.push("- " + (labels[row.theme] || row.theme));
  }
  lines.push("");
  lines.push("Largest themes:");
  const top = Object.entries(facts.theme_author_counts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  for (const [id] of top) lines.push("- " + (labels[id] || id));
  return lines.join("\n");
}

export function parseBridges(raw) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  const list = Array.isArray(data?.statements) ? data.statements : [];
  const kept = [];
  for (const text of list) {
    if (typeof text !== "string") continue;
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean || wordCount(clean) > 15) continue;
    if (/R\d{3}/.test(clean)) continue;
    kept.push({
      text: clean,
      source: "bridge",
      approved: false,
    });
  }
  return kept.slice(0, 5);
}

export function approveBridge(bridges, index, isSteward) {
  if (!isSteward) return { ok: false, bridges };
  const next = (bridges || []).map((row, i) => (i === index ? { ...row, approved: true } : row));
  return { ok: true, bridges: next };
}

export function publicBridges(bridges) {
  return (bridges || []).filter((row) => row.approved).map((row) => ({ text: row.text, source: "bridge" }));
}
