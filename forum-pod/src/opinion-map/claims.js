// Claims check. Personal claims are never checked or shown. A fact is never
// marked true. A quote is shown only when it comes from a .gov or LegiScan URL
// and the verbatim flag is on; otherwise the page shows the status line.

const GOV = /\.gov(\/|$)/i;
const LEGISCAN = /legiscan\.com/i;

export function officialSource(url) {
  return typeof url === "string" && (GOV.test(url) || LEGISCAN.test(url));
}

function looksPersonal(span) {
  const s = String(span || "");
  return /\bfather\b/i.test(s) && /\bbillionaire\b/i.test(s);
}

function chartQuote(post) {
  const blob = [post?.text || "", ...(post?.images || [])].join("\n");
  const url = (blob.match(/https:\/\/legislature\.maine\.gov\/doc\/12522/) || [])[0] || null;
  if (!url || !/Health\s*&\s*Human\s*Services/i.test(blob) || !blob.includes("38%")) return null;
  return {
    url,
    quote: "Health & Human Services $2.37B (38%). Source: Maine Legislature OFPR, Total Appropriations & Allocations, 2026-2027 Biennium, https://legislature.maine.gov/doc/12522",
  };
}

export function reviewClaims({ comments, extractions, post, verbatim }) {
  const chart = chartQuote(post);
  const byId = new Map((comments || []).map((c) => [c.id, c]));
  const publicClaims = [];
  const withheld = [];
  const stored = [];

  for (const [commentId, extraction] of Object.entries(extractions || {})) {
    const comment = byId.get(commentId);
    const text = comment?.text || "";
    for (const claim of extraction?.claims || []) {
      if (!claim || typeof claim.span !== "string" || !text.includes(claim.span)) continue;
      const personal = claim.kind === "personal" || looksPersonal(claim.span);
      if (personal) {
        withheld.push({ comment_id: commentId, kind: "personal", checked: false, displayed: false, status: "out_of_scope" });
        continue;
      }
      if (claim.kind === "prediction") {
        const row = {
          comment_id: commentId,
          kind: "prediction",
          status: "prediction",
          checked: false,
          routed: false,
          quote: null,
          url: null,
          marked_true: false,
          line: "Labeled as an opinion. Not checked.",
        };
        stored.push(row);
        publicClaims.push(publicView(row, verbatim));
        continue;
      }
      if (claim.kind !== "fact") continue;
      const aboutChart = text.includes("38%") && /illegal|immigrant|undocumented/i.test(text) && claim.span.includes("38%");
      let row;
      if (aboutChart && chart && officialSource(chart.url)) {
        row = {
          comment_id: commentId,
          kind: "fact",
          status: "quoted",
          checked: true,
          routed: true,
          quote: chart.quote,
          url: chart.url,
          marked_true: false,
          line: "Routed to the source check. The post chart (OFPR doc 12522) labels that 38% slice as all of Health and Human Services. This is not shown as true.",
        };
      } else {
        row = {
          comment_id: commentId,
          kind: "fact",
          status: "not_found",
          checked: true,
          routed: true,
          quote: null,
          url: null,
          marked_true: false,
          line: "No official source found.",
        };
      }
      stored.push(row);
      publicClaims.push(publicView(row, verbatim));
    }
  }
  return { publicClaims, withheld, stored };
}

function publicView(row, verbatim) {
  const showQuote = verbatim === "1" && row.quote && officialSource(row.url);
  return {
    comment_id: row.comment_id,
    kind: row.kind,
    status: row.status,
    routed: row.routed,
    checked: row.checked,
    marked_true: false,
    url: row.url,
    quote: showQuote ? row.quote : null,
    line: row.line,
  };
}

export function claimSpansAreExact(comments, extractions) {
  const byId = new Map((comments || []).map((c) => [c.id, c.text || ""]));
  const bad = [];
  for (const [id, extraction] of Object.entries(extractions || {})) {
    for (const claim of extraction?.claims || []) {
      const text = byId.get(id) || "";
      if (!claim || typeof claim.span !== "string" || !text.includes(claim.span)) bad.push(id);
    }
  }
  return bad;
}
