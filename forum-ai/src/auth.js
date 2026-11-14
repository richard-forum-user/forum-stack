// A Forum member is already signed in when the browser sends a session
// cookie or an OAuth bearer token. This page does not ask them for a password.
// Admin is a separate username (`admin`) checked against FORUM_AI_ADMIN_PASSWORD.

const FORUM_COOKIE_NAMES = new Set([
  "forum_session",
  "session",
  "connect.sid",
  "forum_oauth",
  "oauth_token",
  "access_token",
  "CF_Authorization",
]);

export function parseCookies(header) {
  const out = new Map();
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name && value) out.set(name, value);
  }
  return out;
}

export function forumCredential(request) {
  const authorization = request.headers.get("authorization") || "";
  if (/^Bearer\s+\S+/i.test(authorization)) {
    return { kind: "oauth", material: authorization };
  }
  const cookies = parseCookies(request.headers.get("cookie"));
  const kept = [];
  for (const [name, value] of cookies) {
    if (FORUM_COOKIE_NAMES.has(name)) kept.push(`${name}=${value}`);
  }
  if (!kept.length) return null;
  return { kind: "cookie", material: kept.join("; ") };
}

async function digest(value) {
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(hash);
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function secretsEqual(provided, expected) {
  if (!provided || !expected) return false;
  const a = await digest(provided);
  const b = await digest(expected);
  return sameBytes(a, b);
}

export async function adminMatches(username, password, expectedPassword) {
  const userOk = await secretsEqual(username, "admin");
  const passOk = await secretsEqual(password, expectedPassword);
  return userOk && passOk;
}
