import { groupOf } from "./allowlist.js";
import { checkQuotes } from "./quote-check.js";
import { chooseQuotes, hasExpertQuote, quoteStage } from "./choose-quotes.js";
import { asksMaine, chooseHost, HOST_PROMPT, isVague, MODEL_ID, modelText, pageRefusal } from "./pick-host.js";
import { asksMaineBills, sessionMissLine } from "./session-bills.js";
import {
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
  return emptyReply(asksMaineBills(comment) ? sessionMissLine() : SPOKEN_REFUSAL);
}

// Fans a check out one stage at a time: bill list, then other .gov pages,
// then the press pages, then journal pages when the question asks for them.
// This function does not fetch.
export async function* walkCheck({ comment, urls, ask, model }) {
  const text = String(comment || "").trim();
  const pasted = (Array.isArray(urls) ? urls : []).filter(Boolean);
  if (!text) {
    yield { type: "done", reply: emptyReply(SPOKEN_REFUSAL) };
    return;
  }
  if (isVague(text)) {
    yield { type: "done", reply: emptyReply(pageRefusal()) };
    return;
  }
  if (isSmallTalk(text, pasted)) {
    yield { type: "done", reply: emptyReply(NO_TARGET) };
    return;
  }

  const buckets = { bills: [], gov: [], press: [], academia: [] };
  const refused = [];
  const seen = new Set();
  let chosenHost = "";
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
    const choice = await chooseHost(text, model);
    if (!choice.url) {
      const answer = asksMaine(text) ? sessionMissLine() : pageRefusal();
      yield { type: "done", reply: emptyReply(answer) };
      return;
    }
    const stage = quoteStage(choice.url);
    if (!stage) {
      refused.push(choice.url);
      yield { type: "done", reply: { ...emptyReply(pageRefusal()), refused } };
      return;
    }
    buckets[stage] = [choice.url];
    chosenHost = choice.host;
  }

  const pace = chosenHost ? `That will take a moment. I'll check ${chosenHost}.` : paceFor(text, pasted);
  yield { type: "pace", pace };

  const stages = [];
  for (const id of STAGE_ORDER) {
    const list = buckets[id];
    const stageComment = text;
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
    const chosen = chooseQuotes(text, [result], { stage: id });
    let quotes = chosen.quotes;
    if (quotes.length) {
      const answer = quotes.map((quote) => `"${quote.text}"`).join(" and ");
      const verdict = checkQuotes({ answer, quotes, pages: chosen.pages });
      if (!verdict.ok) quotes = [];
    }
    const stage = {
      id,
      line: chosenHost ? `Checking ${chosenHost}.` : STAGE_LINE[id],
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
    const env = this.env;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of walkCheck({
            comment: body.comment,
            urls: body.urls,
            model: async (comment) => {
              if (!env?.AI?.run) return "";
              const result = await env.AI.run(MODEL_ID, {
                messages: [
                  { role: "system", content: HOST_PROMPT },
                  { role: "user", content: String(comment || "").slice(0, 2000) },
                ],
                max_tokens: 32,
              });
              return modelText(result);
            },
            ask: async (group, payload) => {
              const ns = env[BINDING[group]];
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
