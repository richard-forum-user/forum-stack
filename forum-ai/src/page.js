import { REFUSAL } from "./quote-check.js";
import { urlAllowed } from "./allowlist.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function commentForm() {
  return `<form method="post" action="/forum-ai">
    <label>Comment
      <textarea name="comment" required maxlength="2000"></textarea>
    </label>
    <label>Links to check. One https link per line.
      <textarea name="sources" placeholder="https://www.maine.gov/"></textarea>
    </label>
    <button type="submit">Check factuality</button>
  </form>`;
}

function adminForm() {
  return `<h2>Admin</h2>
  <form method="post" action="/forum-ai/admin">
    <label>Username <input name="username" autocomplete="username"></label>
    <label>Password <input name="password" type="password" autocomplete="current-password"></label>
    <button type="submit">Admin sign-in</button>
  </form>`;
}

function renderRefused(refused) {
  if (!Array.isArray(refused) || refused.length === 0) return "";
  const items = refused.map((url) => `<li>${escapeHtml(url)}</li>`).join("");
  return `<h3>Not fetched</h3><ul>${items}</ul>`;
}

function renderResult(result) {
  if (!result) return "";
  if (!result.ok) {
    return `<section><h2>Reply</h2><p>${escapeHtml(result.answer || result.refusal || REFUSAL)}</p>${renderRefused(result.refused)}</section>`;
  }
  const quotes = (result.quotes || []).map((quote) => {
    const safeUrl = escapeHtml(quote.url);
    const link = urlAllowed(quote.url)
      ? `<p><a href="${safeUrl}" rel="noreferrer">${safeUrl}</a></p>`
      : "";
    return `<blockquote><p>${escapeHtml(quote.text)}</p>${link}</blockquote>`;
  }).join("<p>and</p>");
  return `<section><h2>Reply</h2>${quotes}${renderRefused(result.refused)}</section>`;
}

export function renderPage({ authorized, kind, result, error }) {
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : "";
  const body = authorized
    ? `<p class="who">${kind === "admin" ? "Signed in as admin." : "Signed in with the Forum session already in this browser."}</p>
       ${commentForm()}
       ${renderResult(result)}`
    : `<p>A Forum session already in this browser opens this page. There is no second password.</p>
       <p>Sign in on the Forum, then open this page again.</p>
       ${adminForm()}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Forum AI</title>
  <style>
    body { margin: 0; background: #f4f1ea; color: #1c1915; font: 17px/1.5 Georgia, serif; }
    main { max-width: 38rem; margin: 0 auto; padding: 28px 18px 64px; }
    label { display: block; margin: 12px 0; }
    textarea, input, button { font: inherit; }
    textarea, input { width: 100%; box-sizing: border-box; }
    textarea { min-height: 7rem; }
    button { margin-top: 8px; }
    blockquote { margin: 0 0 12px; padding-left: 12px; border-left: 3px solid #1c1915; }
    a { color: #1c1915; }
    .err { color: #7a1f1f; }
  </style>
</head>
<body>
<main>
  <h1>Forum AI</h1>
  <p>Quotes from allowlisted government, academic, and press pages. If none match, it says so.</p>
  ${err}
  ${body}
</main>
</body>
</html>`;
}
