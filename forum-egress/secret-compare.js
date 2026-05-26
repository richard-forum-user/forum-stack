async function digestSecret(value) {
  const bytes = new TextEncoder().encode(String(value ?? ''));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(hash);
}

export async function secretsEqual(provided, expected) {
  if (!provided || !expected) return false;
  const a = await digestSecret(provided);
  const b = await digestSecret(expected);
  if (a.length !== b.length) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}
