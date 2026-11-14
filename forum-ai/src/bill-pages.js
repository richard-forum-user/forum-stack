export function isBillDoc(raw) {
  try {
    const url = new URL(raw);
    const path = url.pathname.toLowerCase();
    return path.includes("getpdf")
      || path.includes("billtext")
      || path.includes("fiscalnote")
      || path.endsWith("/summary.asp")
      || path.endsWith("/dockets.asp")
      || path.endsWith("/amendments.asp");
  } catch {
    return false;
  }
}

export function mentionsLd(value, comment) {
  const match = String(comment || "").match(/\bLD\s*#?\s*(\d{1,4})\b/i);
  if (!match) return false;
  const n = String(Number(match[1]));
  const hay = decodeURIComponent(String(value || "")).toLowerCase();
  return new RegExp(`\\bld\\s*#?\\s*0*${n}\\b`).test(hay) || hay.includes(`ld${n}`) || hay.includes(`ld-${n}`);
}
