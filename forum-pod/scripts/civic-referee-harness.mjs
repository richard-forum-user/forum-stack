import { checkReply } from "../src/civic-referee/check-reply.js";

const model = process.env.CIVIC_REFEREE_MODEL || "@cf/meta/llama-3.1-8b-instruct-fp8";
const time = "2026-11-11T15:00:00.000Z";
const gov = "https://legislature.maine.gov/legis/bills/display_ps.asp?LD=307&snum=132";

const cases = [
  {
    name: "quoted .gov figure",
    reply: {
      answer: 'The page says: "Final Disposition Veto Sustained, Apr 29, 2026."',
      quotes: [{ url: gov, text: "Final Disposition Veto Sustained, Apr 29, 2026." }],
      sources: [gov],
      model,
      time,
    },
    ok: true,
  },
  {
    name: "sources do not contain the answer",
    reply: {
      answer: "These sources do not contain that answer.",
      quotes: [],
      sources: [gov],
      model,
      time,
    },
    ok: true,
  },
  {
    name: "source outside .gov and LegiScan",
    reply: {
      answer: 'The page says: "A public note."',
      quotes: [{ url: "https://example.com/note", text: "A public note." }],
      sources: ["https://example.com/note"],
      model,
      time,
    },
    ok: false,
  },
  {
    name: "figure with no quoted source",
    reply: {
      answer: "The override failed 72 to 65.",
      quotes: [],
      sources: [gov],
      model,
      time,
    },
    ok: false,
  },
  {
    name: "vote tally",
    reply: {
      answer: "The page says the room was 49 for and 43 against.",
      quotes: [{ url: gov, text: "49 for and 43 against." }],
      sources: [gov],
      model,
      time,
    },
    ok: false,
  },
  {
    name: "simulated seat",
    reply: {
      answer: "Seat 16 voted against the pause.",
      quotes: [],
      sources: [gov],
      model,
      time,
    },
    ok: false,
  },
];

const failures = [];
for (const item of cases) {
  const verdict = checkReply(item.reply);
  if (verdict.ok !== item.ok) {
    failures.push(`${item.name}: expected ${item.ok ? "pass" : "fail"}, got ${verdict.ok ? "pass" : verdict.errors.join("; ")}`);
  }
}

const liveUrl = process.env.CIVIC_REFEREE_URL;
if (liveUrl) {
  const response = await fetch(liveUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      question: "What is the final disposition of Maine LD 307?",
      sources: [gov],
    }),
  });
  const body = await response.json();
  const verdict = checkReply(body.reply || {});
  const page = await fetch(liveUrl, { method: "GET" });
  const html = await page.text();
  const credits = `Credits: <a href="https://civic.ai/kami/">Audrey Tang’s civic.ai Kami</a>. This worker is ours and is not her Kami.`;
  const creditErrors = [];
  if (body.reply?.credit) creditErrors.push("credit is still on the reply");
  const thread = html.split('id="thread"')[1] || "";
  const threadBeforeForm = thread.split("<form")[0] || "";
  if (threadBeforeForm.includes("Audrey Tang") || threadBeforeForm.includes("civic.ai")) {
    creditErrors.push("credit is inside the thread");
  }
  if (html.split(credits).length - 1 !== 1) creditErrors.push("credits note is not on the page once");
  if (/https?:\/\/(?![^\s]*\.(?:gov|legiscan\.com))/.test(body.reply?.answer || "")) {
    creditErrors.push("the answer itself carries a non-source URL");
  }
  if (!response.ok || !verdict.ok || creditErrors.length) {
    failures.push(`live reply: HTTP ${response.status} ${verdict.errors.join("; ")} ${creditErrors.join("; ")} ${JSON.stringify(body).slice(0, 500)}`);
  } else {
    console.log(JSON.stringify({ live: { status: response.status, reply: body.reply, verdict } }, null, 2));
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`harness passed ${cases.length} fixtures${liveUrl ? " and the live reply" : ""}`);
