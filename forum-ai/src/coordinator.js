import { groupOf } from "./allowlist.js";
import { quoteStage } from "./choose-quotes.js";
import { chooseHost, HOST_PROMPT, isVague, MODEL_ID, modelText } from "./pick-host.js";
import { pageNotes, REPLY_PROMPT, usedLinks, withUsedLink } from "./reply.js";
import {
  isSmallTalk,
  paceFor,
  SPOKEN_REFUSAL,
  STAGE_LINE,
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

function heard(answer, extra = {}) {
  return {
    ok: true,
    refusal: "",
    answer,
    quotes: [],
    refused: extra.refused || [],
    lead: "",
    pace: extra.pace || "",
    stages: extra.stages || [],
    close: answer,
    sources: extra.sources || [],
  };
}

async function spoken(reply, comment, urls, pages) {
  let said = "";
  if (typeof reply === "function") {
    try {
      said = String(await reply({ comment, urls, pages: pages || {} }) || "");
    } catch {
      said = "";
    }
  }
  return withUsedLink(said, urls);
}

// Opens allowlisted pages, then lets the model answer in ordinary sentences.
// This function does not fetch.
export async function* walkCheck({ comment, urls, ask, model, reply }) {
  const text = String(comment || "").trim();
  const pasted = (Array.isArray(urls) ? urls : []).filter(Boolean);
  if (!text) {
    yield { type: "done", reply: emptyReply(SPOKEN_REFUSAL) };
    return;
  }
  if (isVague(text) || isSmallTalk(text, pasted)) {
    const answer = await spoken(reply, text, [], {});
    yield { type: "done", reply: heard(answer) };
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
      const answer = await spoken(reply, text, [], {});
      yield { type: "done", reply: heard(answer) };
      return;
    }
    const stage = quoteStage(choice.url);
    if (!stage) {
      refused.push(choice.url);
      const answer = await spoken(reply, text, [], {});
      yield { type: "done", reply: heard(answer, { refused }) };
      return;
    }
    buckets[stage] = [choice.url];
    chosenHost = choice.host;
  }

  const pace = chosenHost ? `That will take a moment. I'll check ${chosenHost}.` : paceFor(text, pasted);
  yield { type: "pace", pace };

  const stages = [];
  const requested = [];
  const pages = {};
  for (const id of STAGE_ORDER) {
    const list = buckets[id];
    if (!list || !list.length) continue;
    requested.push(...list);
    let result = { pages: {} };
    try {
      result = (await ask(groupForStage(id), {
        comment: text,
        urls: list,
        stage: id,
      })) || result;
    } catch {
      result = { pages: {} };
    }
    Object.assign(pages, result.pages || {});
    const stage = {
      id,
      line: chosenHost ? `Checking ${chosenHost}.` : STAGE_LINE[id],
      quotes: [],
      empty: "",
    };
    stages.push(stage);
    yield { type: "stage", stage };
  }

  const links = usedLinks(requested, pages);
  const answer = await spoken(reply, text, links, pages);
  yield {
    type: "done",
    reply: heard(answer, { refused, pace, stages, sources: links }),
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
            reply: async ({ comment, urls, pages }) => {
              if (!env?.AI?.run) return "";
              const notes = pageNotes(urls, pages);
              const result = await env.AI.run(MODEL_ID, {
                messages: [
                  { role: "system", content: REPLY_PROMPT },
                  {
                    role: "user",
                    content: `Question: ${String(comment || "").slice(0, 2000)}\n\n${notes || "No page was opened."}`,
                  },
                ],
                max_tokens: 400,
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
