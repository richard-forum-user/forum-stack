import { SPOKEN_REFUSAL } from "./speak.js";
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
  }).join("");
}

export function renderStageBlock(stage) {
  if (!stage) return "";
  const line = stage.line ? `<p>${escapeHtml(stage.line)}</p>` : "";
  const quotes = renderQuotes(stage.quotes);
  const empty = !quotes && stage.empty ? `<p>${escapeHtml(stage.empty)}</p>` : "";
  return `${line}${quotes}${empty}`;
}

function renderRefused(refused) {
  if (!Array.isArray(refused) || refused.length === 0) return "";
  const items = refused.map((url) => `<li>${escapeHtml(url)}</li>`).join("");
  return `<p class="refused">Not fetched</p><ul>${items}</ul>`;
}

function linkify(text) {
  return String(text || "").split(/(https:\/\/[^\s]+)/).map((part) => {
    if (!part.startsWith("https://")) return escapeHtml(part);
    const trimmed = part.replace(/[.,)]+$/, "");
    const tail = part.slice(trimmed.length);
    if (!urlAllowed(trimmed)) return escapeHtml(part);
    const safe = escapeHtml(trimmed);
    return `<a href="${safe}" rel="noreferrer">${safe}</a>${escapeHtml(tail)}`;
  }).join("");
}

function renderTurn(turn) {
  if (turn.role === "user") {
    return `<li class="user"><p>${escapeHtml(turn.text)}</p></li>`;
  }
  const staged = Array.isArray(turn.stages) && turn.stages.length > 0;
  const quotes = staged ? turn.stages.map(renderStageBlock).join("") : renderQuotes(turn.quotes);
  const pace = turn.pace ? `<p>${escapeHtml(turn.pace)}</p>` : "";
  const line = pace ? "" : (turn.lead ? `<p>${escapeHtml(turn.lead)}</p>` : "");
  const close = turn.close ? `<p>${linkify(turn.close)}</p>` : "";
  const text = quotes || close ? "" : `<p>${linkify(turn.text || SPOKEN_REFUSAL)}</p>`;
  return `<li class="assistant">${pace}${line}${text}${quotes}${close}${renderRefused(turn.refused)}</li>`;
}

function whoLine(kind) {
  const who = kind === "admin"
    ? "Signed in as admin."
    : "Signed in with the Forum session already in this browser.";
  return `<p class="who">${who}</p>
    <p>Replies are quotes from allowlisted pages, or a refusal.</p>`;
}

function composer() {
  return `<form method="post" action="/forum-ai" class="composer">
      <label>Message
        <textarea name="message" required maxlength="2000"></textarea>
      </label>
      <button type="submit">Send</button>
    </form>`;
}

function chat(kind, thread) {
  const turns = (thread || []).map(renderTurn).join("");
  return `${whoLine(kind)}
    <ol class="thread">${turns}</ol>
    ${composer()}`;
}

function pageTop({ authorized, error }) {
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : "";
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
  ${err}`;
}

function pageBottom() {
  return `</main>
</body>
</html>`;
}

export function renderPage({ authorized, kind, thread, error }) {
  const body = authorized ? chat(kind, thread) : loginForm();
  return `${pageTop({ authorized, error })}
  ${body}
${pageBottom()}`;
}

// The pacing sentence is the first bytes of a check. Stage quotes are appended
// after it, once that stage has finished.
export function renderPageStart({ authorized, kind, thread, error, userText, pace }) {
  const prior = (thread || []).map(renderTurn).join("");
  const user = `<li class="user"><p>${escapeHtml(userText || "")}</p></li>`;
  const opening = pace ? `<p>${escapeHtml(pace)}</p>` : "";
  return `${pageTop({ authorized, error })}
  ${whoLine(kind)}
    <ol class="thread">${prior}${user}<li class="assistant">${opening}`;
}

export function renderPageEnd({ close, refused }) {
  const closing = close ? `<p>${linkify(close)}</p>` : "";
  return `${closing}${renderRefused(refused)}</li></ol>
    ${composer()}
${pageBottom()}`;
}
