// Plans the fixture seed. Display names are Resident 001. Author keys stay off
// the public rows. Image descriptions are stored with the comment because
// group_comments has no image column.

export const FIXTURE_GROUP_NAME = "Maine budget gap 2028–29 (fixture)";
export const FIXTURE_ID = "maine-budget-gap-2028-29";

export function residentLabel(authorKey) {
  const n = String(authorKey || "").replace(/^R/, "");
  return "Resident " + n;
}

export function residentHandle(authorKey) {
  const n = String(authorKey || "").replace(/^R/, "");
  return "res-" + n;
}

export function planSeed(fixture) {
  const authors = [];
  const seen = new Set();
  for (const comment of fixture.comments) {
    if (seen.has(comment.author)) continue;
    seen.add(comment.author);
    authors.push({
      author_key: comment.author,
      handle: residentHandle(comment.author),
      display_name: residentLabel(comment.author),
    });
  }
  const post = {
    fixture_post_id: fixture.post.id,
    text: fixture.post.text,
    images: fixture.post.images || [],
  };
  const comments = fixture.comments.map((comment, index) => ({
    fixture_comment_id: comment.id,
    parent_id: comment.parent_id,
    author_handle: residentHandle(comment.author),
    display_name: residentLabel(comment.author),
    text: comment.text,
    images: comment.images || [],
    stored_text: [comment.text, ...(comment.images || [])].filter((part) => part && String(part).trim()).join("\n"),
    order: index,
  }));
  return {
    group: {
      name: FIXTURE_GROUP_NAME,
      type: "issue",
      place: "Maine",
      is_fixture: 1,
      slug: "fixture-maine-budget-gap-2028-29",
      visibility: "public_read",
      encryption_mode: "server",
    },
    thread_config: {
      ...fixture.thread_config,
      mode: "open_question",
      stance_phrases: null,
    },
    post,
    authors,
    comments,
  };
}

export function publicListing(plan, showFixtures) {
  if (plan.group.is_fixture && !showFixtures) return [];
  return [{ name: plan.group.name, type: plan.group.type, place: plan.group.place }];
}

export function publicCommentProjection(plan) {
  return plan.comments.map((comment) => ({
    display_name: comment.display_name,
  }));
}
