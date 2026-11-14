import { REFUSAL } from "./quote-check.js";
import { urlAllowed } from "./allowlist.js";

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loginForm() {
  return `<form method="post" action="/forum-ai/admin">
    <label>Username <input name="username" autocomplete="username"></label>
    <label>Password <input name="password" type="password" autocomplete="current-password"></label>
    <button type="submit">Sign in</button>
  </form>`;
}

function renderQuotes(quotes) {
  return (quotes || []).map((quote) => {
    const safeUrl = escapeHtml(quote.url);
    const link = urlAllowed(quote.url)
      ? `<p><a href="${safeUrl}" rel="noreferrer">${safeUrl}</a></p>`
      : "";
    return `<blockquote><p>${escapeHtml(quote.text)}</p>${link}</blockquote>`;
  }).join("<p>and</p>");
}

function renderRefused(refused) {
  if (!Array.isArray(refused) || refused.length === 0) return "";
  const items = refused.map((url) => `<li>${escapeHtml(url)}</li>`).join("");
  return `<p class="refused">Not fetched</p><ul>${items}</ul>`;
}

function renderTurn(turn) {
  if (turn.role === "user") {
    return `<li class="user"><p>${escapeHtml(turn.text)}</p></li>`;
  }
  const quotes = renderQuotes(turn.quotes);
  const text = quotes
    ? ""
    : `<p>${escapeHtml(turn.text || REFUSAL)}</p>`;
  return `<li class="assistant">${text}${quotes}${renderRefused(turn.refused)}</li>`;
}

function chat(kind, thread) {
  const who = kind === "admin"
    ? "Signed in as admin."
    : "Signed in with the Forum session already in this browser.";
  const turns = (thread || []).map(renderTurn).join("");
  return `<p class="who">${who}</p>
    <p>Replies are quotes from allowlisted pages, or a refusal.</p>
    <ol class="thread">${turns}</ol>
    <form method="post" action="/forum-ai" class="composer">
      <label>Message
        <textarea name="message" required maxlength="2000"></textarea>
      </label>
      <button type="submit">Send</button>
    </form>`;
}

export function renderPage({ authorized, kind, thread, error }) {
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : "";
  const body = authorized ? chat(kind, thread) : loginForm();
  const lead = authorized
    ? ""
    : `<p>Use the Forum session already in this browser, or sign in as admin.</p>`;
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
    textarea { min-height: 4.5rem; }
    button { margin-top: 8px; }
    .thread { list-style: none; margin: 18px 0; padding: 0; }
    .user, .assistant { margin: 0 0 12px; padding: 10px 12px; }
    .user { background: #e7e1d6; }
    .assistant { background: #fff; border: 1px solid #d9d3c7; }
    blockquote { margin: 0 0 12px; padding-left: 12px; border-left: 3px solid #1c1915; }
    a { color: #1c1915; }
    .err { color: #7a1f1f; }
    .refused { margin-bottom: 0; }
  </style>
</head>
<body>
<main>
  <h1>Forum AI</h1>
  ${lead}
  ${err}
  ${body}
</main>
</body>
</html>`;
}
