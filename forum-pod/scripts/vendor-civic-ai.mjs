import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const execFile = promisify(execFileCb);

const REPO_URL = "https://github.com/audreyt/civic.ai.git";
const OPENCLAW_SKILL_URLS = [
  "https://kami.civic.ai/.well-known/openclaw/SKILL.md",
  "https://civic.ai/.well-known/openclaw/SKILL.md",
];

// `new URL("..", import.meta.url).pathname` returns `/D:/…` on Windows,
// which `path.resolve` then doubles into `D:\D:\…`. fileURLToPath
// produces the correct platform-native path on every OS.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_OUT = path.join(ROOT, "public", "civic-ai");
const SRC_OUT = path.join(ROOT, "src", "civic-ai");
const AIRLOCK_PROMPT_MODULE = path.resolve(ROOT, "..", "forum-airlock", "civic-ai-system-prompt.js");

const CONTENT_FILES = [
  "1.md",
  "2.md",
  "3.md",
  "4.md",
  "5.md",
  "6.md",
  "manifesto.md",
  "faq.md",
  "measures.md",
  "inside-the-kami.md",
  "ai-alignment-cannot-be-top-down.md",
];

const PACK_SUMMARIES = [
  ["1", "Attentiveness", "Caring about", "What do the people closest to the pain notice that we are missing?"],
  ["2", "Responsibility", "Taking care of", "Who is accountable, with what authority, and what happens if they fail?"],
  ["3", "Competence", "Care-giving", "Does the system demonstrably work - audited, explainable, safe-to-fail?"],
  ["4", "Responsiveness", "Care-receiving", "Can those affected correct the system, and does correction actually change it?"],
  ["5", "Solidarity", "Caring with", "Does the ecosystem structurally reward cooperation over lock-in?"],
  ["6", "Symbiosis", "Kami of Care", "Is the system bounded, sunset-ready, and incapable of imperial creep?"],
];

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "forum-pod-civic-ai-vendor",
      "Accept": "text/plain, text/markdown, */*",
    },
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  if (/^\s*<!doctype html/i.test(text) || /<html[\s>]/i.test(text)) {
    throw new Error(`fetch ${url} returned HTML, not markdown`);
  }
  return text;
}

async function cloneRepo(tmpDir) {
  await execFile("git", ["clone", "--depth", "1", REPO_URL, tmpDir], {
    cwd: os.tmpdir(),
    maxBuffer: 1024 * 1024 * 8,
  });
  const { stdout } = await execFile("git", ["rev-parse", "HEAD"], {
    cwd: tmpDir,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function copyContent(repoDir) {
  await rm(PUBLIC_OUT, { recursive: true, force: true });
  await mkdir(PUBLIC_OUT, { recursive: true });
  for (const file of CONTENT_FILES) {
    const source = path.join(repoDir, file);
    if (!existsSync(source)) {
      throw new Error(`Missing civic.ai source file: ${file}`);
    }
    const content = await readFile(source, "utf8");
    await writeFile(path.join(PUBLIC_OUT, file), content);
  }
}

async function writeSkill(repoDir) {
  await mkdir(SRC_OUT, { recursive: true });
  let skill;
  for (const url of OPENCLAW_SKILL_URLS) {
    try {
      skill = await fetchText(url);
      break;
    } catch {
      /* try the next canonical surface */
    }
  }
  if (!skill) {
    const guide = await readFile(
      path.join(repoDir, "_includes", "openclaw", "guide-body.md.njk"),
      "utf8"
    );
    skill = [
      "# Civic AI OpenClaw Bootstrap Guide",
      "",
      "Fetched fallback from audreyt/civic.ai _includes/openclaw/guide-body.md.njk.",
      "",
      guide,
    ].join("\n");
  }
  await writeFile(path.join(SRC_OUT, "skill.md"), skill);
  return skill;
}

async function writeSystemPrompt(skill, commit) {
  const packTable = PACK_SUMMARIES
    .map(([n, pack, phase, question]) => `- Pack ${n}: ${pack} (${phase}) - ${question}`)
    .join("\n");
  const prompt = [
    "# Forum Pod Civic AI Kami System Prompt",
    "",
    "You are the local Civic AI Kami for the Forum Pod cooperative.",
    "",
    "Scope:",
    "- Serve as a bounded, place-specific steward for the member using this Pod.",
    "- Keep relational health, public accountability, and reversibility ahead of optimization.",
    "- Help the member understand, organize, and reflect on their own Pod data without claiming authority over the community.",
    "",
    "Hard red-lines:",
    "- Do not ask for or reveal secrets, passkeys, private keys, unlock tokens, or Cloudflare credentials.",
    "- Do not encourage surveillance, coercion, doxxing, impersonation, or targeted political manipulation.",
    "- Do not pretend to be a civic authority, government service, lawyer, doctor, or emergency responder.",
    "- Do not claim that outputs are verified facts when they are interpretations or suggestions.",
    "- Invite correction, contestation, and a human stop/forget path when uncertainty or harm appears.",
    "",
    "## You do NOT have access to the user's Pod data",
    "",
    "The Forum Pod intentionally does not give you the user's saved Pod data",
    "(Forum Submissions, Journal entries, Behaviors, Traits). An earlier",
    "build did, and the resulting hallucinations were unacceptable.",
    "",
    "Therefore on every turn:",
    "",
    "- Do not claim to know what the user has submitted, journalled, or had",
    "  inferred about them. You cannot read any of it.",
    "- Do not invent dates, ZIP codes, categories, comment text, behaviors,",
    "  or trait values. Do not soften a fabrication by calling it an",
    "  \"example\" or a \"placeholder\".",
    "- Do not claim memory of prior sessions, prior devices, or earlier",
    "  conversations beyond the messages you can see in this transcript.",
    "- If the user asks anything about their own data — e.g. \"what did I",
    "  submit\", \"how many entries do I have\", \"tell me about my", 
    "  behaviors\" — respond plainly that you cannot see Pod data, and",
    "  redirect them to the **Explore** tab. The Explore tab runs",
    "  deterministic SQL against their device cache and shows exact",
    "  rows; that is where data questions belong.",
    "- Do not ask the user to paste their data, a \"pod context\", a",
    "  \"context string\", or any block of their saved rows. You do not",
    "  need it and accepting it would not change what you are allowed to",
    "  claim.",
    "",
    "## What you CAN help with",
    "",
    "- The 6-Pack of Care framework summarised below: what each pack means,",
    "  examples of attentiveness vs. responsiveness, how to think about",
    "  bridge-building vs. lock-in.",
    "- Civic concepts in the abstract: deliberation, accountability,",
    "  contestation, sunset clauses, public measures of care.",
    "- How this Forum Pod works: that it is local-first, that the Personal",
    "  Pod Durable Object holds their data, that the Explore tab is where",
    "  they look at their own rows, that Forum Submissions can be shared",
    "  with the cooperative or kept private.",
    "- Reflective questions the user can ask themselves before submitting",
    "  or journalling — without naming or guessing the answer for them.",
    "",
    "If a request falls outside these areas, say so briefly and offer to",
    "help with one of them instead.",
    "",
    `Vendored from audreyt/civic.ai commit ${commit}.`,
    "",
    "## 6-Pack of Care Summary",
    "",
    packTable,
    "",
    "## Upstream Civic AI Skill",
    "",
    skill.trim(),
    "",
  ].join("\n");
  await writeFile(path.join(SRC_OUT, "system-prompt.txt"), prompt);
  if (existsSync(path.dirname(AIRLOCK_PROMPT_MODULE))) {
    await writeFile(
      AIRLOCK_PROMPT_MODULE,
      `// Generated by forum-pod/scripts/vendor-civic-ai.mjs. Do not edit by hand.\nexport default ${JSON.stringify(prompt)};\n`
    );
  }
}

async function writeVersion(commit) {
  const version = {
    upstream: "audreyt/civic.ai",
    url: "https://github.com/audreyt/civic.ai",
    commit,
    license: "CC0-1.0",
    vendoredAt: new Date().toISOString(),
    files: CONTENT_FILES,
    skillUrls: OPENCLAW_SKILL_URLS,
  };
  await writeFile(path.join(SRC_OUT, "VERSION.json"), `${JSON.stringify(version, null, 2)}\n`);
}

async function main() {
  const tmpDir = path.join(os.tmpdir(), `forum-civic-ai-${Date.now()}`);
  await rm(tmpDir, { recursive: true, force: true });
  try {
    const commit = await cloneRepo(tmpDir);
    await copyContent(tmpDir);
    const skill = await writeSkill(tmpDir);
    await writeSystemPrompt(skill, commit);
    await writeVersion(commit);
    console.log(`Vendored audreyt/civic.ai ${commit}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
