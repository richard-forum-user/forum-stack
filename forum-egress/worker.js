import { secretsEqual } from './secret-compare.js';

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      if (!env.FORUM_REPORTS) {
        return new Response(JSON.stringify({ error: "FORUM_REPORTS KV is not configured" }), {
          status: 503,
          headers: { "Content-Type": "application/json" }
        });
      }

      const latest = await env.FORUM_REPORTS.get("latest", "json");
      if (!latest) {
        return new Response(JSON.stringify({ error: "No report has been published yet" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }

      const status = latest.metadata?.status || "published";
      if (status === "review") {
        return new Response(renderReport(latest, { reviewOnly: true }), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store"
          }
        });
      }

      return new Response(renderReport(latest), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store"
        }
      });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" }
      });
    }

    const authHeader = request.headers.get("X-Forum-Secret");
    if (!(await secretsEqual(authHeader, env.FORUM_SECRET))) {
      return new Response(JSON.stringify({ error: "Unauthorized access" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    try {
      const payload = await request.json();
      console.log(`Received report for: ${payload.metadata?.project}`);
      console.log(`Generated at: ${payload.metadata?.timestamp}`);

      if (env.FORUM_REPORTS) {
        const key = `report_${payload.metadata.timestamp}`;
        await env.FORUM_REPORTS.put(key, JSON.stringify(payload));
        if (payload.metadata?.status !== "review") {
          await env.FORUM_REPORTS.put("latest", JSON.stringify(payload));
        }
      }

      return new Response(JSON.stringify({
        status: "Acknowledge",
        received_iso: new Date().toISOString(),
        message: "Report successfully cleared egress and stored."
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({
        error: "Failed to process payload",
        details: err.message
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderReport(payload, options = {}) {
  const metadata = payload.metadata || {};
  const inReview = options.reviewOnly || metadata.status === "review";
  const reviewBanner = inReview
    ? `<div class="meta" style="border-color:#6e4b00;background:#2d2208">
        <strong>Formation pilot — review period.</strong>
        This aggregate is based on ${escapeHtml(metadata.opt_in_count ?? "opt-in")} opted-in submissions only.
        It is not representative of all residents. Public listing may be delayed per cooperative articles (7-day review).
        ${escapeHtml(metadata.disclaimer || "")}
      </div>`
    : "";
  const disclaimer = metadata.disclaimer
    ? `<p style="color:#8b949e;font-size:13px;line-height:1.5">${escapeHtml(metadata.disclaimer)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ForumAI Cooperative Report</title>
  <style>
    body { margin: 0; background: #090b0f; color: #d1d5db; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    main { max-width: 920px; margin: 0 auto; padding: 32px 20px; }
    h1 { color: #f9fafb; font-size: 24px; }
    .meta { color: #8b949e; border: 1px solid #22272e; border-radius: 10px; padding: 14px; margin: 18px 0; }
    pre { white-space: pre-wrap; line-height: 1.55; background: #111827; border: 1px solid #22272e; border-radius: 10px; padding: 18px; }
  </style>
</head>
<body>
  <main>
    <h1>ForumAI Cooperative Report</h1>
    ${reviewBanner}
    <div class="meta">
      <div>Project: ${escapeHtml(metadata.project || "The Forum Initiative")}</div>
      <div>Generated: ${escapeHtml(metadata.timestamp || "unknown")}</div>
      <div>Opt-in submissions: ${escapeHtml(metadata.opt_in_count ?? metadata.volume ?? 0)}</div>
      <div>Policy: ${escapeHtml(metadata.policy_version || "coop-data-policy/2026-05-01")}</div>
      <div>Status: ${escapeHtml(metadata.status || "published")}</div>
    </div>
    ${disclaimer}
    <pre>${escapeHtml(payload.report || "")}</pre>
  </main>
</body>
</html>`;
}
