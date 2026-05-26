import { getPodProviderUrl, getSolidSession } from "./solid-session.js";
import { signBundle } from "./pod-signing.js";
import { enrichSignedEnvelope } from "./signing-envelope.js";

function sseEventsFromBuffer(buffer) {
  const events = buffer.split("\n\n");
  return {
    complete: events.slice(0, -1),
    remainder: events[events.length - 1] || "",
  };
}

function parseSseEvent(block) {
  const event = { type: "message", data: "" };
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event.type = line.slice(6).trim() || "message";
    } else if (line.startsWith("data:")) {
      event.data += line.slice(5).trim();
    }
  }
  return event;
}

async function readErrorResponse(res) {
  try {
    const body = await res.json();
    return body.message || body.reason || body.error || res.statusText;
  } catch {
    return res.statusText;
  }
}

export async function streamAiChat({ messages, onDelta, signal }) {
  const session = getSolidSession();
  if (!session.isLoggedIn) {
    throw new Error("Sign in to your Pod before using Civic AI.");
  }
  // The Kami does NOT receive Pod data context. We tried per-turn
  // snapshots in v1.9; a 14B-q4 model on a small context hallucinated
  // rows under every prompt variant. For data questions, the user
  // belongs on the Explore tab.
  const payload = {
    webId: session.webId,
    messages: (messages || []).map((msg) => ({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: String(msg.content || ""),
    })),
    requestedAt: new Date().toISOString(),
  };
  const signed = enrichSignedEnvelope(await signBundle(payload));
  const base = getPodProviderUrl();
  const res = await fetch(`${base}/api/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signed),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Civic AI request failed (${res.status}): ${await readErrorResponse(res)}`);
  }
  if (!res.body) {
    throw new Error("Civic AI response did not include a stream.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { complete, remainder } = sseEventsFromBuffer(buffer);
    buffer = remainder;
    for (const block of complete) {
      const event = parseSseEvent(block);
      if (event.type === "done") {
        return fullText;
      }
      if (!event.data) continue;
      const data = JSON.parse(event.data);
      if (data.content) {
        fullText += data.content;
        onDelta?.(data.content, fullText);
      }
    }
  }
  return fullText;
}
