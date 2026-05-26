/**
 * Keep in sync with forum-pod/src/civic-vocab.js FORUM_FEEDBACK_MAX_COMMENT_CHARS.
 * Submissions are clamped in the Pod before sync; the Worker clamps again on ingest.
 */
export const FORUM_FEEDBACK_MAX_COMMENT_CHARS = 2000;

export function clampForumFeedbackComment(text, maxChars = FORUM_FEEDBACK_MAX_COMMENT_CHARS) {
  const s = String(text ?? '').trim();
  const max = Number(maxChars) || FORUM_FEEDBACK_MAX_COMMENT_CHARS;
  if (s.length <= max) return s;
  return s.slice(0, max);
}
