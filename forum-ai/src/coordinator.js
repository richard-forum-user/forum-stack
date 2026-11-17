import { groupOf } from "./allowlist.js";
import { checkQuotes } from "./quote-check.js";
import { chooseQuotes, hasExpertQuote, quoteStage } from "./choose-quotes.js";
import { stageSeeds } from "./search-seeds.js";
import { expertQuery, scholarSeeds } from "./scholar.js";
import { asksSessionBills, sessionMissLine } from "./session-bills.js";
import {
  asksExperts,
  closingLine,
  isSmallTalk,
  NO_TARGET,
  paceFor,
  SPOKEN_REFUSAL,
  STAGE_EMPTY,
  STAGE_LINE,
  statusLine,
} from "./speak.js";

const BINDING = { gov: "GOV", academia: "ACADEMIA", press: "PRESS" };
const STAGE_ORDER = ["bills", "gov", "press", "academia"];

function groupForStage(stage) {
  if (stage === "bills" || stage === "gov") return "gov";
  return stage;
}

function emptyReply(answer) {
  return {
    ok: false,
    refusal: answer,
    answer,
    quotes: [],
    refused: [],
    lead: "",
    pace: "",
    stages: [],
    close: answer,
    sources: [],
  };
}

function missed(comment) {
  return emptyReply(asksSessionBills(comment) ? sessionMissLine() : SPOKEN_REFUSAL);
}

// Fans a check out one stage at a time: bill list, then other .gov pages,
// then the press pages, then journal pages when the question asks for them.
// This function does not fetch.
export async function* walkCheck({ comment, urls, ask }) {
  const text = String(comment || "").trim();
  const pasted = (Array.isArray(urls) ? urls : []).filter(Boolean);
  if (!text) {
    yield { type: "done", reply: emptyReply(SPOKEN_REFUSAL) };
    return;
  }
  if (isSmallTalk(text, pasted)) {
    yield { type: "done", reply: emptyReply(NO_TARGET) };
    return;
  }

  const pace = paceFor(text, pasted);
  yield { type: "pace", pace };

  const buckets = { bills: [], gov: [], press: [], academia: [] };
  const refused = [];
  const seen = new Set();
  if (pasted.length) {
    for (const raw of pasted) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      const stage = quoteStage(raw);
      if (!stage || (groupOf(raw) == null)) {
        refused.push(raw);
        continue;
      }
      buckets[stage].push(raw);
    }
  } else {
    const seeds = stageSeeds(text);
    buckets.bills = seeds.bills;
    buckets.gov = seeds.gov;
    buckets.press = seeds.press;
    buckets.academia = asksExperts(text) ? [] : seeds.academia;
  }

  const stages = [];
  let govText = "";
  for (const id of STAGE_ORDER) {
    let list = buckets[id];
    let stageComment = text;
    if (id === "academia" && !pasted.length && asksExperts(text)) {
      const query = expertQuery(text, govText);
      list = scholarSeeds(query.term);
      stageComment = `${text} ${query.hint}`.slice(0, 2000);
    }
    if (!list || !list.length) continue;
    let result = { quotes: [], pages: {} };
    try {
      result = (await ask(groupForStage(id), {
        comment: stageComment,
        urls: list,
        stage: id,
      })) || result;
    } catch {
      result = { quotes: [], pages: {} };
    }
    if (id === "bills" || id === "gov") {
      govText += `\n${Object.values(result.pages || {}).join("\n")}`;
    }
    const chosen = chooseQuotes(text, [result], { stage: id });
    let quotes = chosen.quotes;
    if (quotes.length) {
      const answer = quotes.map((quote) => `"${quote.text}"`).join(" and ");
      const verdict = checkQuotes({ answer, quotes, pages: chosen.pages });
      if (!verdict.ok) quotes = [];
    }
    const stage = {
      id,
      line: STAGE_LINE[id],
      quotes,
      empty: quotes.length ? "" : STAGE_EMPTY[id],
    };
    stages.push(stage);
    yield { type: "stage", stage };
  }

  const quotes = stages.flatMap((stage) => stage.quotes);
  if (!quotes.length) {
    const reply = missed(text);
    reply.refused = refused;
    reply.pace = pace;
    reply.stages = stages;
    yield { type: "done", reply };
    return;
  }
  const answer = quotes.map((quote) => `"${quote.text}"`).join(" and ");
  yield {
    type: "done",
    reply: {
      ok: true,
      answer,
      quotes,
      refused,
      lead: statusLine(text, quotes, hasExpertQuote(quotes)),
      pace,
      stages,
      close: closingLine(quotes),
      sources: [...new Set(quotes.map((quote) => quote.url))],
    },
  };
}

export async function runCoordinator(input) {
  let reply = emptyReply(SPOKEN_REFUSAL);
  for await (const event of walkCheck(input)) {
    if (event.type === "done") reply = event.reply;
  }
  return reply;
}

export class ForumAiCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const body = await request.json();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of walkCheck({
            comment: body.comment,
            urls: body.urls,
            ask: async (group, payload) => {
              const ns = this.env[BINDING[group]];
              const stub = ns.get(ns.idFromName(group));
              const res = await stub.fetch("https://agent/check", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
              });
              return res.json();
            },
          })) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }
        } catch {
          const reply = emptyReply(SPOKEN_REFUSAL);
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "done", reply })}\n`));
        }
        controller.close();
      },
    }, new CountQueuingStrategy({ highWaterMark: 32 }));
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
}
