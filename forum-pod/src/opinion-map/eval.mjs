import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { placeAuthors, countRegions } from "./place.js";
import { parseModelJson, themeIdSet, validateExtraction } from "./validate.js";
import { markStance } from "./marker.js";
import { promptForComment, PROMPT_VERSION, DEFAULT_EXTRACT_MODEL } from "./extract.js";
import { reviewClaims, claimSpansAreExact } from "./claims.js";
import { buildFacts, circleDisplayLabels, guardSummary, renderReport, shortWords } from "./report.js";
import { approveBridge, publicBridges, wordCount } from "./bridge.js";
import { buildMapModel, renderObservePage, renderVennHtml } from "./venn.js";
import { planSeed, publicCommentProjection, publicListing, FIXTURE_GROUP_NAME } from "./seed.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const evalDir = join(root, "eval");

const NAME_DIFFERENCES = [
  "Spec tables are described as D1. The test state keeps groups, posts, comments, members, and civic_reports in the Family Durable Object SQLite database. There is no separate D1 database on podlink-ai-test-state. The seed plan uses thread_configs, comment_extractions, thread_themes, claim_checks, and place_taps in that same database. Those tables are not created on the live DO in this deploy.",
  "groups has no is_fixture column and no place column. The seed plan sets is_fixture = 1 and place = Maine on the thread config, and would hide the group from listings and the auto-report scan unless ?show_fixtures=1. The live route does not insert the group: it checks x-sim-token and returns stored false. The map is drawn on the observe page only when that query is present.",
  "group_comments has no parent_id and no image column. Replies stay comments on the opening post, and image descriptions are appended to the stored text. The public observe payload omits that text.",
  "The internal gate already on this worker is the x-sim-token header checked against SIM_INTERNAL_TOKEN, the same check as /internal/sim. The seed and run routes use that header. No new secret is added.",
  "CIVIC_EXTRACT_MODEL is not a binding on the test worker. The code default is @cf/meta/llama-3.3-70b-instruct-fp8-fast at temperature 0. Asking that model for JSON mode returned broken keys, so the call parses a JSON object from the reply instead of setting response_format. The 8B model is not used. CIVIC_REPORT_AUTO_AI is left at 0. A new plain-text binding was not uploaded, because a full script settings replace can drop secrets.",
  "The fixture has no thread_config.themes key. The theme list is the union of circle themes, process_themes, and unplaced_themes, with labels from theme_labels.",
  "The fixture PRO circle label is longer than five words. The page shows Protect residents.",
  "LD 307 has no thread_configs row. A missing mode keeps today's single-proposal marker, so the three meters stay. open_question skips the marker and the meter. single_proposal reads stance_phrases from the thread config.",
  "Bridge drafts do not fit an existing statement source column. They are stored as thread config JSON with source = bridge and approved = false. The public page does not show them until a steward approves.",
  "CIVIC_PUBLISH_VERBATIM_COMMENTS is not set on the test worker. It is treated as off. Comment text stays off the public page.",
  "Authors are stored as res-001 and shown as Resident 001. R001 is not written into public HTML.",
  "There is no package.json at the forum-stack root. npm run eval:opinion-map is defined on forum-pod.",
];

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : "";
}

function sameCounts(got, expected) {
  const keys = new Set([...Object.keys(got), ...Object.keys(expected)]);
  const diffs = [];
  for (const key of keys) {
    if ((got[key] || 0) !== (expected[key] || 0)) diffs.push(key + " got " + (got[key] || 0) + " expected " + (expected[key] || 0));
  }
  return diffs;
}

function leaked(html, fixture) {
  if (/R\d{3}/.test(html)) return ["author key"];
  const labels = Object.values(fixture.theme_labels || {});
  const rendered = labels.flatMap((label) => [label, shortWords(label, 5)]);
  const leaks = [];
  for (const comment of fixture.comments) {
    const text = (comment.text || "").trim();
    if (text.length < 8) continue;
    let rest = html;
    for (const label of rendered) {
      if (label && label.includes(text)) rest = rest.split(label).join("");
    }
    if (rest.includes(text)) leaks.push(comment.id);
  }
  return leaks;
}

function withinPct(got, expected, pct) {
  const low = expected * (1 - pct);
  const high = expected * (1 + pct);
  return got >= low && got <= high;
}

const tests = [];
function check(id, name, pass, detail) {
  tests.push({ id, name, pass: Boolean(pass), detail });
}

const fixtureId = argValue("--fixture");
const fixturePath = join(root, "fixtures/opinion-map/maine-budget-gap-thread.fixture.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
if (fixture.fixture_id !== fixtureId) {
  console.error("Fixture id is " + fixture.fixture_id + ", not " + fixtureId);
  process.exit(1);
}

const goldComments = fixture.comments.map((c) => ({
  id: c.id,
  author: c.author,
  themes: c.gold.themes,
  tone: c.gold.tone,
  opposes: c.gold.opposes,
}));
const goldPlacement = placeAuthors(goldComments, fixture.thread_config);
const goldAgain = placeAuthors(goldComments, fixture.thread_config);
const goldCountDiffs = sameCounts(countRegions(goldPlacement), fixture.expected.author_region_counts);
let goldAuthorMiss = 0;
for (const [author, region] of Object.entries(fixture.expected.author_placement)) {
  if (goldPlacement[author] !== region) goldAuthorMiss += 1;
}
check(
  "gold",
  "Gold themes reproduce author_region_counts",
  goldCountDiffs.length === 0 && goldAuthorMiss === 0 && JSON.stringify(goldPlacement) === JSON.stringify(goldAgain),
  goldCountDiffs.join("; ") || (goldAuthorMiss ? goldAuthorMiss + " authors differ" : "exact"),
);

const themeIds = themeIdSet(fixture.thread_config);
const sample = "Cut the fraud and do not tax second homes. 38% to illegals.";
const good = validateExtraction({
  themes: ["fraud_waste_audit", "not_a_theme"],
  new_theme_suggestions: [],
  opposes: ["second_home_tax"],
  claims: [
    { span: "38% to illegals", kind: "fact" },
    { span: "this span was invented", kind: "fact" },
  ],
  tone: "constructive",
  specificity: 1,
}, sample, themeIds);
check(
  "unit-span",
  "Claim span must be an exact substring",
  good.ok && good.value.claims.length === 1 && good.value.claims[0].span === "38% to illegals" && good.droppedClaims.length === 1,
  "kept " + good.value?.claims?.length + ", dropped " + good.droppedClaims.length,
);
check(
  "unit-theme",
  "Unknown theme moves to suggestions",
  good.value.themes.includes("fraud_waste_audit") && !good.value.themes.includes("not_a_theme") && good.value.new_theme_suggestions.some((s) => s.id === "not_a_theme"),
  good.value.themes.join(","),
);
const unknown = validateExtraction({
  themes: [],
  note: "extra",
  tone: "venting",
  specificity: 0,
  opposes: [],
  claims: [],
  new_theme_suggestions: [],
}, sample, themeIds);
check("unit-unknown", "Unknown fields fail validation", unknown.ok === false && unknown.value === null, unknown.errors.join(","));
const badJson = parseModelJson("not json");
const recovered = parseModelJson('prefix {"tone":"venting","specificity":0,"themes":[],"opposes":[],"claims":[],"new_theme_suggestions":[]}');
check("unit-json", "Invalid JSON is detected and a JSON object can be recovered", badJson.ok === false && recovered.ok === true, badJson.error || "");
const badTone = validateExtraction({ themes: [], opposes: [], claims: [], new_theme_suggestions: [], tone: "angry", specificity: 0 }, sample, themeIds);
check("unit-tone", "Tone outside the list fails", badTone.ok === false, badTone.errors.join(","));

const open = { mode: "open_question", stance_phrases: { support: ["for the pause"], oppose: ["kills jobs"] } };
const single = { mode: "single_proposal", stance_phrases: { support: ["for the pause"], oppose: ["kills jobs"] } };
check("unit-marker-open", "Open question skips the phrase marker", markStance("This kills jobs and I am for the pause", open) === null, "");
check("unit-marker-oppose", "Single proposal checks oppose before support", markStance("This kills jobs and I am for the pause", single) === "oppose", "");
check("unit-marker-support", "Single proposal support phrase", markStance("I am for the pause", single) === "support", "");
check("unit-marker-missing", "Missing mode does not run as single_proposal", markStance("I am for the pause", { stance_phrases: single.stance_phrases }) === null, "");

const prompt = promptForComment(fixture.comments[0], fixture.post, fixture.thread_config, fixture.theme_labels);
check("unit-prompt", "Extraction prompt omits the author key", !prompt.includes(fixture.comments[0].author) && prompt.includes("THREAD QUESTION:"), "");

const plan = planSeed(fixture);
const planAgain = planSeed(fixture);
const projection = JSON.stringify(publicCommentProjection(plan));
check(
  "unit-seed",
  "Seed plan is idempotent and hides author keys",
  plan.group.name === FIXTURE_GROUP_NAME &&
    plan.group.type === "issue" &&
    plan.group.place === "Maine" &&
    plan.group.is_fixture === 1 &&
    plan.thread_config.mode === "open_question" &&
    plan.authors[0].display_name === "Resident 001" &&
    plan.comments.length === 129 &&
    JSON.stringify(plan) === JSON.stringify(planAgain) &&
    !/R\d{3}/.test(projection) &&
    publicListing(plan, false).length === 0 &&
    publicListing(plan, true).length === 1,
  plan.authors[0].display_name,
);

const cachePath = join(evalDir, "extraction-cache.json");
const bridgePath = join(evalDir, "bridges.json");
let pipeline = null;
let cache = null;
if (existsSync(cachePath)) {
  cache = JSON.parse(readFileSync(cachePath, "utf8"));
  const comments = [];
  const failures = [];
  const extractions = {};
  for (const comment of fixture.comments) {
    const row = cache.comments?.[comment.id];
    const parsed = row?.value || null;
    if (!row || row.status !== "ok" || !parsed) {
      failures.push(comment.id);
      comments.push({ id: comment.id, author: comment.author, themes: [], opposes: [], tone: "venting", claims: [] });
      continue;
    }
    const again = validateExtraction(parsed, comment.text || "", themeIds);
    if (!again.ok || !again.value) {
      failures.push(comment.id);
      comments.push({ id: comment.id, author: comment.author, themes: [], opposes: [], tone: "venting", claims: [] });
      continue;
    }
    extractions[comment.id] = again.value;
    comments.push({
      id: comment.id,
      author: comment.author,
      themes: again.value.themes,
      opposes: again.value.opposes,
      tone: again.value.tone,
      claims: again.value.claims,
    });
  }
  const placement = placeAuthors(comments, fixture.thread_config);
  const placementAgain = placeAuthors(comments, fixture.thread_config);
  pipeline = { comments, failures, extractions, placement, placementAgain, cache };
}

const modelNote = pipeline
  ? "model " + (cache.model_id || DEFAULT_EXTRACT_MODEL) + ", prompt " + (cache.prompt_version || PROMPT_VERSION) + ", failures " + pipeline.failures.length
  : "extraction cache missing; model tests were not run";

if (!pipeline) {
  for (const [id, name] of [
    ["1", "Author placement agreement"],
    ["2", "Center authors"],
    ["3", "Region counts"],
    ["4", "Theme recall"],
    ["5", "Pushback"],
    ["6", "Tone"],
    ["7", "Claims"],
    ["9", "Determinism"],
  ]) {
    check(id, name, false, modelNote);
  }
} else {
  let agree = 0;
  const authorDiffs = [];
  for (const [author, region] of Object.entries(fixture.expected.author_placement)) {
    if (pipeline.placement[author] === region) agree += 1;
    else authorDiffs.push(author + " model " + (pipeline.placement[author] || "missing") + " gold " + region);
  }
  check("1", "Author placement agreement", agree >= 103, agree + " of 121 authors match (need 103). " + modelNote);

  const centerOk = pipeline.placement.R007 === "CUT+REV+PRO" && pipeline.placement.R033 === "CUT+REV+PRO";
  check("2", "Center authors", centerOk, "R007=" + pipeline.placement.R007 + " R033=" + pipeline.placement.R033);

  const expectedRegions = {
    CUT: [46, 5],
    venting: [43, 6],
    process: [7, 2],
    PRO: [5, 2],
    REV: [5, 2],
    "CUT+PRO": [4, 2],
    pushback_only: [4, 2],
    off_topic: [3, 2],
    "REV+PRO": [2, 1],
    "CUT+REV+PRO": [2, 0],
    "CUT+REV": [0, 1],
  };
  const gotCounts = {};
  for (const region of Object.values(pipeline.placement)) {
    const key = region.startsWith("outside:") ? region.slice(8) : region;
    gotCounts[key] = (gotCounts[key] || 0) + 1;
  }
  const regionFails = [];
  for (const [key, [gold, tol]] of Object.entries(expectedRegions)) {
    const got = gotCounts[key] || 0;
    const ok = key === "CUT+REV" ? got <= 1 : key === "CUT+REV+PRO" ? got === gold : Math.abs(got - gold) <= tol;
    if (!ok) regionFails.push(key + " got " + got + " gold " + gold);
  }
  check("3", "Region counts", regionFails.length === 0, regionFails.join("; ") || "within tolerance");

  const themeGold = {
    fraud_waste_audit: 16,
    noncitizen_benefits: 13,
    cut_hhs: 9,
    second_home_tax: 6,
    cut_general: 5,
    school_consolidation_admin: 5,
    property_tax_relief: 5,
    cut_state_admin: 4,
    process_question: 3,
    tax_high_earners: 3,
    tax_relief_residents: 3,
    across_board_cut: 3,
    cut_education: 3,
    cut_specific_items: 3,
    protect_services: 3,
  };
  const themeGot = {};
  const authorsByTheme = new Map();
  for (const comment of pipeline.comments) {
    if (!authorsByTheme.has(comment.author)) authorsByTheme.set(comment.author, new Set());
    for (const theme of comment.themes) authorsByTheme.get(comment.author).add(theme);
  }
  for (const themes of authorsByTheme.values()) {
    for (const theme of themes) themeGot[theme] = (themeGot[theme] || 0) + 1;
  }
  const themeFails = [];
  for (const [theme, gold] of Object.entries(themeGold)) {
    const got = themeGot[theme] || 0;
    if (!withinPct(got, gold, 0.25)) themeFails.push(theme + " got " + got + " gold " + gold);
  }
  check("4", "Theme recall", themeFails.length === 0, themeFails.join("; ") || "every listed theme is within 25%");

  const forSecond = themeGot.second_home_tax || 0;
  const againstSecond = new Set(pipeline.comments.filter((c) => c.opposes.includes("second_home_tax")).map((c) => c.author)).size;
  const againstNew = new Set(pipeline.comments.filter((c) => c.opposes.includes("new_taxes")).map((c) => c.author)).size;
  const facts = buildFacts({
    comments: pipeline.comments,
    placement: pipeline.placement,
    failures: pipeline.failures.length,
    labels: fixture.theme_labels,
  });
  const report = renderReport(facts, circleDisplayLabels(fixture.thread_config));
  const pushOk = forSecond === 6 && againstSecond === 1 && Math.abs(againstNew - 4) <= 1 && report.includes("second-home tax: 6 for, 1 against");
  check("5", "Pushback", pushOk, "second_home_tax " + forSecond + " for, " + againstSecond + " against; new_taxes " + againstNew);

  let toneAgree = 0;
  fixture.comments.forEach((comment, i) => {
    const goldConstructive = comment.gold.tone === "constructive";
    const modelConstructive = pipeline.comments[i].tone === "constructive";
    if (goldConstructive === modelConstructive) toneAgree += 1;
  });
  check("6", "Tone", toneAgree >= Math.ceil(129 * 0.8), toneAgree + " of 129 comments agree on constructive vs not");

  const claimReview = reviewClaims({
    comments: fixture.comments,
    extractions: pipeline.extractions,
    post: fixture.post,
    verbatim: "0",
  });
  const k02 = claimReview.stored.find((row) => row.comment_id === "C071" && row.routed && row.status === "quoted" && row.marked_true === false);
  const k13public = JSON.stringify(claimReview.publicClaims).toLowerCase();
  const k13withheld = claimReview.withheld.some((row) => row.comment_id === "C125" && row.checked === false && row.displayed === false);
  const anyTrue = claimReview.stored.some((row) => row.marked_true) || claimReview.publicClaims.some((row) => row.marked_true);
  const k13hidden = !k13public.includes("billionaire") && !k13public.includes("pingree");
  check(
    "7",
    "Claims",
    Boolean(k02) && k02.quote.includes("Health") && k13withheld && k13hidden && !anyTrue,
    k02 ? "K02 routed" : "K02 was not extracted as a fact claim",
  );

  const badSpans = claimSpansAreExact(fixture.comments, pipeline.extractions);
  check("8", "Hallucination guard", badSpans.length === 0, badSpans.length ? badSpans.join(",") : "zero bad spans");
  check("9", "Determinism", JSON.stringify(pipeline.placement) === JSON.stringify(pipeline.placementAgain), "two placement runs");

  const mock = guardSummary("About 999 people want cuts.", facts, "0");
  const kept = guardSummary(facts.n_authors + " people commented.", facts, "0");
  const keyed = guardSummary("R001 wants cuts.", facts, "0");
  check("10", "Count guard", mock === null && kept !== null && keyed === null, mock === null ? "wrong number dropped" : "wrong number kept");

  const map = buildMapModel({
    placement: pipeline.placement,
    comments: pipeline.comments,
    config: fixture.thread_config,
    labels: fixture.theme_labels,
    claims: claimReview.publicClaims,
    frustration: facts.frustration,
  });
  map.common = facts.common_ground.map((row) => ({
    theme: row.theme,
    full: fixture.theme_labels[row.theme] || row.theme,
    authors: row.authors,
  }));
  const page = renderObservePage(map);
  const leaks = leaked(page + "\n" + report, fixture);
  check("11", "Privacy", leaks.length === 0, leaks.slice(0, 8).join(", ") || "no author keys and no comment text");

  const html = renderVennHtml(map);
  const threeCircles = (html.match(/<circle /g) || []).length === 3;
  const hasAlt = html.includes("text-alternative") && html.includes("people");
  const shots = ["opinion-map-desktop.png", "opinion-map-380.png"].map((name) =>
    join("/cursor/stores/bc-e3883ae6-cd3e-4df0-b777-299f33a69f59/media", name),
  );
  const shotsOk = shots.every((path) => existsSync(path) && statSync(path).size > 1000);
  check("12", "Venn", threeCircles && hasAlt && shotsOk, shotsOk ? "html and screenshots" : "screenshots missing or html incomplete");

  mkdirSync(evalDir, { recursive: true });
  writeFileSync(join(evalDir, "observe.html"), page);
  writeFileSync(join(evalDir, "report.md"), report);

  const lines = ["# Fixture disagreements", "", "Gold labels were not edited. These rows are where the model extraction disagrees with the gold. This file does not say the gold is wrong.", ""];
  lines.push("Author placement mismatches: " + authorDiffs.length);
  for (const row of authorDiffs) lines.push("- " + row);
  lines.push("");
  lines.push("Theme count mismatches:");
  for (const row of themeFails) lines.push("- " + row);
  if (!themeFails.length) lines.push("- none");
  writeFileSync(join(evalDir, "fixture-disagreements.md"), lines.join("\n") + "\n");

  const bridges = existsSync(bridgePath) ? JSON.parse(readFileSync(bridgePath, "utf8")) : [];
  const bridgeOk = bridges.length >= 3 && bridges.length <= 5 && bridges.every((row) => wordCount(row.text) <= 15 && row.source === "bridge" && row.approved === false);
  const approved = approveBridge(bridges, 0, true).bridges;
  const hidden = publicBridges(bridges);
  check("bridge", "Bridge statements", bridgeOk && hidden.length === 0 && approved[0]?.approved === true, bridges.map((row) => row.text).join(" | ") || "none");
  pipeline.report = report;
  pipeline.bridges = bridges;
  pipeline.agree = agree;
}

if (!pipeline) {
  check("8", "Hallucination guard", false, modelNote);
  check("10", "Count guard", false, modelNote);
  check("11", "Privacy", false, modelNote);
  check("12", "Venn", false, modelNote);
  check("bridge", "Bridge statements", false, modelNote);
  const lines = ["# Fixture disagreements", "", "The model extraction was not available for this run, so there are no model-versus-gold rows to log. Gold labels were not edited.", ""];
  writeFileSync(join(evalDir, "fixture-disagreements.md"), lines.join("\n"));
}

mkdirSync(evalDir, { recursive: true });
const score = {
  fixture_id: fixture.fixture_id,
  model: pipeline ? cache.model_id : null,
  prompt_version: pipeline ? cache.prompt_version : PROMPT_VERSION,
  tests,
};
writeFileSync(join(evalDir, "scorecard.json"), JSON.stringify(score, null, 2));
const md = ["# Opinion map scorecard", "", "Fixture: " + fixture.fixture_id, "", "Name differences:", ""];
for (const row of NAME_DIFFERENCES) md.push("- " + row);
md.push("", "## Tests", "");
for (const row of tests) {
  md.push("- " + row.id + " " + row.name + ": " + (row.pass ? "pass" : "fail") + (row.detail ? " — " + row.detail : ""));
}
md.push("");
if (pipeline?.bridges?.length) {
  md.push("## Bridge statements", "");
  for (const row of pipeline.bridges) md.push("- " + row.text + " (approved: " + row.approved + ")");
  md.push("");
}
writeFileSync(join(evalDir, "scorecard.md"), md.join("\n"));
const failed = tests.filter((row) => !row.pass);
console.log(tests.map((row) => (row.pass ? "pass" : "FAIL") + " " + row.id + " " + row.name + (row.detail ? " — " + row.detail : "")).join("\n"));
process.exit(failed.length ? 1 : 0);
