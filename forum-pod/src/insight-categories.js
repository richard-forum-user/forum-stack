// Categories for Forum Feedback.

export const INSIGHT_CATEGORIES = [
  // Behavioral — what the user did
  { id: "purchase",  label: "Bought something",          kind: "behavioral",   category: "purchasing" },
  { id: "media",     label: "Watched / read / listened", kind: "behavioral",   category: "media" },
  { id: "civic_act", label: "Civic action",              kind: "behavioral",   category: "civic" },
  { id: "social",    label: "Community / social",        kind: "behavioral",   category: "social" },
  { id: "health",    label: "Health / body",             kind: "behavioral",   category: "health" },

  // Psychographic — how the user feels / what they value
  { id: "value",     label: "Value or belief",           kind: "psychographic", category: "value" },
  { id: "interest",  label: "Interest / hobby",          kind: "psychographic", category: "interest" },
  { id: "lifestyle", label: "Lifestyle",                 kind: "psychographic", category: "lifestyle" },
  { id: "opinion",   label: "Opinion / attitude",        kind: "psychographic", category: "attitude" },
];

export function findInsightCategory(id) {
  return INSIGHT_CATEGORIES.find((c) => c.id === id) || null;
}

export const INSIGHT_CATEGORY_OPTIONS = INSIGHT_CATEGORIES.map((c) => ({
  id: c.id,
  label: c.label,
  group: c.kind === "behavioral" ? "What I did" : "How I think / what I value",
}));
