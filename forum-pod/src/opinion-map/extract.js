import { createHash } from "node:crypto";
import { themeIdSet } from "./validate.js";

export const PROMPT_VERSION = "extract-v1";
export const DEFAULT_EXTRACT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export function commentTextHash(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

export function extractionCacheKey(text, modelId) {
  return commentTextHash(text) + "|" + PROMPT_VERSION + "|" + modelId;
}

export function themeLines(config, labels) {
  const ids = [...themeIdSet(config)];
  return ids.map((id) => id + ": " + (labels[id] || id)).join("\n");
}

export function extractionPrompt({ postText, imageDescriptions, commentText, themeList }) {
  const images = imageDescriptions && String(imageDescriptions).trim()
    ? String(imageDescriptions).trim()
    : "";
  return [
    "You are labeling one comment from a public discussion so it can be grouped with others.",
    "Do not judge whether the person is right. Do not add information that is not in the comment.",
    "",
    "THREAD QUESTION:",
    postText || "",
    "",
    "THEMES YOU MAY USE (id: label):",
    themeList || "",
    "",
    "TONE OPTIONS: constructive (proposes or argues something), venting (frustration, no proposal),",
    "attack (insults a person or group), sarcasm, meta (comments on the discussion itself), off_topic.",
    "",
    "COMMENT:",
    commentText || "",
    images,
    "",
    "Return only JSON matching the schema. A comment can have several themes or none.",
    '"opposes" = themes the comment argues AGAINST (e.g., "don\'t tax second homes" opposes second_home_tax).',
    '"claims" = statements presented as fact or prediction; copy the exact words from the comment.',
    'Mark claims about a private individual or someone\'s family as kind "personal".',
    "",
    "Schema:",
    '{"themes":["snake_case_theme_id"],"new_theme_suggestions":[{"id":"snake_case","label":"short label"}],"opposes":["snake_case_theme_id"],"claims":[{"span":"exact substring of the comment","kind":"fact|prediction|personal"}],"tone":"constructive|venting|attack|sarcasm|meta|off_topic","specificity":0}',
    "specificity is 0 (no proposal), 1 (names an area), or 2 (names an area plus an amount or a mechanism).",
    "Use only the keys in the schema.",
  ].join("\n");
}

export function postImageBlock(post) {
  return (post?.images || []).filter(Boolean).join("\n");
}

export function commentImageBlock(comment) {
  return (comment?.images || []).filter(Boolean).join("\n");
}

export function promptForComment(comment, post, config, labels) {
  const postText = [post?.text || "", postImageBlock(post)].filter(Boolean).join("\n\n");
  return extractionPrompt({
    postText,
    imageDescriptions: commentImageBlock(comment),
    commentText: comment?.text || "",
    themeList: themeLines(config, labels),
  });
}
