import { regionKey } from "./place.js";
import { circleDisplayLabels, shortWords } from "./report.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const POS = {
  CUT: [118, 118],
  REV: [242, 118],
  PRO: [180, 196],
  "CUT+REV": [180, 92],
  "CUT+PRO": [124, 176],
  "REV+PRO": [236, 176],
  "CUT+REV+PRO": [180, 142],
};

export function buildMapModel({ placement, comments, config, labels, claims, frustration, taps }) {
  const display = circleDisplayLabels(config);
  const regions = {};
  for (const [author, region] of Object.entries(placement || {})) {
    if (!regions[region]) regions[region] = { id: region, people: 0, themes: {} };
    regions[region].people += 1;
    const mine = new Set();
    for (const c of comments) {
      if (c.author !== author) continue;
      for (const t of c.themes || []) mine.add(t);
    }
    for (const t of mine) regions[region].themes[t] = (regions[region].themes[t] || 0) + 1;
  }
  const seven = ["CUT", "REV", "PRO", "CUT+REV", "CUT+PRO", "REV+PRO", "CUT+REV+PRO"];
  for (const id of seven) {
    if (!regions[id]) regions[id] = { id, people: 0, themes: {} };
  }
  const regionList = Object.values(regions).map((row) => {
    const themes = Object.entries(row.themes)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, n]) => ({ id, label: shortWords(labels[id] || id, 5), full: labels[id] || id, people: n }));
    return { ...row, themes, label: regionTitle(row.id, display) };
  });
  regionList.sort((a, b) => b.people - a.people || a.id.localeCompare(b.id));
  const outside = regionList.filter((r) => r.id.startsWith("outside:") && r.people > 0);
  const circles = ["CUT", "REV", "PRO"].map((id) => ({
    id,
    label: display[id] || id,
    people: Object.entries(placement).filter(([, region]) => (region || "").split("+").includes(id)).length,
  }));
  return {
    title: "Maine budget gap 2028–29 (fixture)",
    circles,
    regions: regionList,
    outside,
    claims: claims || [],
    frustration: frustration || { venting: 0, attack: 0 },
    taps: taps || {},
  };
}

function regionTitle(id, display) {
  if (id.startsWith("outside:")) {
    const name = regionKey(id).replace(/_/g, " ");
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return id.split("+").map((part) => display[part] || part).join(" + ");
}

export function renderVennHtml(model) {
  const circles = [
    { id: "CUT", cx: 130, cy: 118, fill: "rgba(196,148,92,0.42)", stroke: "#e0b56a" },
    { id: "REV", cx: 230, cy: 118, fill: "rgba(90,140,114,0.42)", stroke: "#8fbfa2" },
    { id: "PRO", cx: 180, cy: 188, fill: "rgba(96,132,168,0.42)", stroke: "#9bb4cc" },
  ];
  const byId = Object.fromEntries(circles.map((c) => [c.id, c]));
  const svg = [];
  svg.push('<svg viewBox="0 0 360 280" role="img" aria-labelledby="venn-title">');
  svg.push('<title id="venn-title">Three circles counting people, not comments</title>');
  for (const c of circles) {
    const meta = model.circles.find((row) => row.id === c.id);
    svg.push('<circle cx="' + c.cx + '" cy="' + c.cy + '" r="78" fill="' + c.fill + '" stroke="' + c.stroke + '" stroke-width="2"></circle>');
    svg.push('<text x="' + c.cx + '" y="' + (c.cy - 68) + '" text-anchor="middle" fill="#f3ead7" font-size="11">' + escapeHtml(meta?.label || c.id) + "</text>");
  }
  for (const region of model.regions) {
    if (region.id.startsWith("outside:") || !POS[region.id] || region.people === 0) continue;
    const [x, y] = POS[region.id];
    svg.push('<text x="' + x + '" y="' + y + '" text-anchor="middle" fill="#f3ead7" font-size="16" font-weight="700">' + region.people + "</text>");
    svg.push('<text x="' + x + '" y="' + (y + 14) + '" text-anchor="middle" fill="#f3ead7" font-size="10">people</text>');
  }
  svg.push("</svg>");

  const picks = model.regions
    .filter((r) => !r.id.startsWith("outside:"))
    .map((r) => {
      const full = r.themes.map((t) => t.full + " (" + t.people + " people)").join("; ");
      const hint = r.themes.slice(0, 2).map((t) => t.label).join(", ");
      return '<button type="button" class="region-pick" data-region="' + escapeHtml(r.id) + '" data-full="' + escapeHtml(full) + '" aria-expanded="false">' + escapeHtml(r.label) + ": " + r.people + " people" + (hint ? " — " + escapeHtml(hint) : "") + "</button>";
    })
    .join("");

  const outside = model.outside
    .map((r) => "<li>" + escapeHtml(r.label) + ": " + r.people + " people</li>")
    .join("");

  const alt = model.regions
    .map((r) => "<li>" + escapeHtml(r.label) + ": " + r.people + " people</li>")
    .join("");

  const claims = (model.claims || [])
    .map((c) => {
      const link = c.url ? ' <a href="' + escapeHtml(c.url) + '">Source</a>' : "";
      return "<li>" + escapeHtml(c.line || c.status) + link + "</li>";
    })
    .join("");

  const ground = (model.common || [])
    .slice(0, 5)
    .map((row) => "<li>" + escapeHtml(shortWords(row.full || row.theme, 5)) + ": " + row.authors + " people across circles</li>")
    .join("");

  const land = ["CUT", "REV", "PRO", "CUT+REV", "CUT+PRO", "REV+PRO", "CUT+REV+PRO"]
    .map((id) => '<button type="button" class="land-pick" data-land="' + id + '">' + escapeHtml(id) + "</button>")
    .join("");

  return [
    '<section class="opinion-map" id="opinion-map">',
    "<style>",
    ".opinion-map{color:#f3ead7;background:#1c1915;padding:12px 12px 20px;max-width:760px;box-sizing:border-box}",
    ".opinion-map h2,.opinion-map h3{font-weight:600;margin:14px 0 6px}",
    ".opinion-map p,.opinion-map li{line-height:1.4}",
    ".map-layout{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}",
    ".map-layout svg{flex:1 1 220px;width:100%;max-width:100%;height:auto}",
    ".outside{flex:1 1 140px;min-width:0}",
    ".region-picks,.land-picks{display:flex;flex-wrap:wrap;gap:6px}",
    ".region-pick,.land-pick{background:#2a241c;color:#f3ead7;border:1px solid #6d5c45;border-radius:999px;padding:6px 10px;font:inherit}",
    ".region-detail{margin-top:8px}",
    ".opinion-map a{color:#e0b56a}",
    "@media (max-width:380px){.opinion-map{padding:8px}.region-pick,.land-pick{font-size:14px}}",
    "</style>",
    "<h2>" + escapeHtml(model.title) + "</h2>",
    '<p class="lede">Open question. People are counted once, in the circles their comments touch.</p>',
    '<div class="map-layout">',
    svg.join(""),
    '<div class="outside"><h3>Outside the circles</h3><ul>' + outside + "</ul></div>",
    "</div>",
    "<h3>Regions</h3>",
    '<div class="region-picks">' + picks + "</div>",
    '<p class="region-detail" hidden></p>',
    '<h3>People in each region</h3>',
    '<ul class="text-alternative">' + alt + "</ul>",
    "<h3>Common ground</h3>",
    "<ul>" + (ground || "<li>None yet.</li>") + "</ul>",
    "<h3>Claims check</h3>",
    "<ul>" + (claims || "<li>No official source found.</li>") + "</ul>",
    "<h3>Where do you land?</h3>",
    '<div class="land-picks">' + land + "</div>",
    '<p class="land-result">Pick a region. Your tap is stored for this browser.</p>',
    "<h3>Bridge statements</h3>",
    "<p>Bridge statements are drafted and waiting for a steward. They are not open for a vote yet.</p>",
    "<h3>Frustration</h3>",
    "<p>" + (model.frustration.venting || 0) + " comments were mainly frustration.</p>",
    "</section>",
  ].join("");
}

export function vennClientScript() {
  return [
    "(function(){",
    "var root=document.getElementById('opinion-map');",
    "if(!root) return;",
    "var detail=root.querySelector('.region-detail');",
    "root.addEventListener('click', function(ev){",
    "var region=ev.target.closest('.region-pick');",
    "if(region && detail){",
    "detail.hidden=false;",
    "detail.textContent=region.getAttribute('data-region')+': '+(region.getAttribute('data-full')||'');",
    "region.setAttribute('aria-expanded','true');",
    "return;",
    "}",
    "var land=ev.target.closest('.land-pick');",
    "if(!land) return;",
    "var id=land.getAttribute('data-land');",
    "var key='opinion-map-tap';",
    "var prev=localStorage.getItem(key);",
    "localStorage.setItem(key, id);",
    "var line=root.querySelector('.land-result');",
    "if(line) line.textContent='You landed on '+id+(prev&&prev!==id?' (replaced '+prev+')':'')+'.';",
    "});",
    "})();",
  ].join("");
}

export function renderObservePage(model) {
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Maine budget gap 2028–29 (fixture)</title>",
    "<style>html,body{margin:0;background:#1c1915;color:#f3ead7;font:16px/1.45 Georgia,serif}</style>",
    "</head><body>",
    renderVennHtml(model),
    "<script>" + vennClientScript() + "</script>",
    "</body></html>",
  ].join("");
}
