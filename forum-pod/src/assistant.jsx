import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { streamAiChat } from "./ai-client.js";
import {
  clearAssistantConversation,
  loadAssistantConversation,
  saveAssistantConversation,
} from "./assistant-store.js";
import CivicAiReader from "./civic-ai-reader.jsx";
import {
  deleteAssistantConversationFromPod,
  syncAssistantConversationFromPod,
  writeAssistantMessageToPod,
} from "./pod-solid-integration.js";

const TOPIC = "default";

const S = {
  shell: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  header: { padding: "14px 18px", borderBottom: "1px solid #161b22", background: "#0d1117" },
  modeBtn: (active) => ({
    background: active ? "#1f6feb" : "#161b22",
    border: `1px solid ${active ? "#1f6feb" : "#30363d"}`,
    color: active ? "#fff" : "#8b949e",
    borderRadius: 999,
    padding: "5px 11px",
    fontSize: 11,
    fontFamily: "inherit",
    cursor: "pointer",
  }),
  body: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: 16, overflow: "hidden" },
  transcript: { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, paddingRight: 4 },
  bubble: (role) => ({
    maxWidth: "78%",
    alignSelf: role === "user" ? "flex-end" : "flex-start",
    background: role === "user" ? "linear-gradient(135deg, #1a3a5c, #0d2137)" : "#161b22",
    border: role === "user" ? "1px solid #1e4976" : "1px solid #21262d",
    borderRadius: role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
    padding: "10px 13px",
    whiteSpace: "pre-wrap",
    lineHeight: 1.55,
  }),
  inputRow: { borderTop: "1px solid #161b22", paddingTop: 12, marginTop: 12, display: "flex", gap: 8, alignItems: "flex-end" },
  input: {
    flex: 1,
    minHeight: 58,
    background: "#161b22",
    border: "1px solid #30363d",
    borderRadius: 8,
    padding: "10px 12px",
    color: "#c9d1d9",
    fontSize: 13,
    fontFamily: "inherit",
    outline: "none",
    resize: "vertical",
  },
  sendBtn: (disabled) => ({
    padding: "10px 16px",
    background: disabled ? "#21262d" : "#1f6feb",
    border: "none",
    borderRadius: 8,
    color: disabled ? "#484f58" : "#fff",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: 12,
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  }),
};

function assistantMessage(id, content = "") {
  return {
    id,
    role: "assistant",
    content,
    created_at: new Date().toISOString(),
  };
}

export default function Assistant({ webId }) {
  const [mode, setMode] = useState("chat");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const transcriptRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Pod is the source of truth. Pull the conversation from the
        // DO first; the local IDB is just the cache mirror. If the Pod
        // fetch fails (e.g. transient network), fall back to the local
        // cache so the user is not stranded.
        const pod = await syncAssistantConversationFromPod(TOPIC);
        if (cancelled) return;
        if (Array.isArray(pod.messages)) {
          setMessages(pod.messages);
          await saveAssistantConversation(webId, pod.messages, TOPIC);
        } else {
          const rows = await loadAssistantConversation(webId, TOPIC);
          if (!cancelled) setMessages(rows);
        }
      } catch (e) {
        if (cancelled) return;
        try {
          const rows = await loadAssistantConversation(webId, TOPIC);
          if (!cancelled) {
            setMessages(rows);
            setStatus({ ok: false, text: `Loaded local cache only: ${e.message}` });
          }
        } catch (cacheErr) {
          if (!cancelled) setStatus({ ok: false, text: cacheErr.message });
        }
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [webId]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [messages]);

  const apiMessages = useMemo(
    () => messages.map(({ role, content }) => ({ role, content })).filter((msg) => msg.content.trim()),
    [messages]
  );

  const persistMessages = useCallback(
    (next) => {
      setMessages(next);
      saveAssistantConversation(webId, next, TOPIC).catch((e) => {
        setStatus({ ok: false, text: e.message });
      });
    },
    [webId]
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    const userMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    const replyId = crypto.randomUUID();
    const assistantPlaceholder = assistantMessage(replyId);
    const next = [...messages, userMessage, assistantPlaceholder];

    setBusy(true);
    setStatus(null);

    // Pod-first invariant (Handover 13): the user message must be
    // durable in the Pod DO before we call the model. If that write
    // fails, abort cleanly and do not invoke Ollama.
    try {
      await writeAssistantMessageToPod(TOPIC, userMessage);
    } catch (e) {
      setBusy(false);
      setStatus({ ok: false, text: `Could not save message to Pod: ${e.message}` });
      return;
    }

    persistMessages(next);
    setInput("");
    abortRef.current = new AbortController();
    let streamed = "";
    try {
      // The Kami does NOT receive Pod data. v1.9 attempts to inject
      // a snapshot proved unworkable: a 14B-q4 model on a small
      // context hallucinates rows under any prompt we tried. Users
      // who want to look at their own data use the Explore tab,
      // which renders deterministic SQL results.
      await streamAiChat({
        messages: [...apiMessages, { role: "user", content: text }],
        signal: abortRef.current.signal,
        onDelta: (_delta, fullText) => {
          streamed = fullText;
          setMessages((current) =>
            current.map((msg) => (msg.id === replyId ? { ...msg, content: fullText } : msg))
          );
        },
      });
      const finalReply = { ...assistantPlaceholder, content: streamed };
      const finalMessages = next.map((msg) => (msg.id === replyId ? finalReply : msg));
      try {
        await writeAssistantMessageToPod(TOPIC, finalReply);
      } catch (e) {
        setStatus({
          ok: false,
          text: `Reply received but Pod sync failed: ${e.message}. It is still in the local cache.`,
        });
      }
      persistMessages(finalMessages);
    } catch (e) {
      const errorText = e.name === "AbortError" ? "Stopped." : e.message;
      const finalMessages = next.map((msg) =>
        msg.id === replyId ? { ...msg, content: streamed || errorText } : msg
      );
      persistMessages(finalMessages);
      setStatus({ ok: e.name === "AbortError", text: errorText });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [apiMessages, busy, input, messages, persistMessages]);

  const forget = useCallback(async () => {
    abortRef.current?.abort();
    try {
      await deleteAssistantConversationFromPod(TOPIC);
    } catch (e) {
      setStatus({ ok: false, text: `Could not clear Pod copy: ${e.message}` });
      return;
    }
    await clearAssistantConversation(webId, TOPIC);
    setMessages([]);
    setStatus({ ok: true, text: "Conversation forgotten on this device and in your Pod." });
  }, [webId]);

  return (
    <div style={S.shell}>
      <div style={S.header}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
          <button type="button" onClick={() => setMode("chat")} style={S.modeBtn(mode === "chat")}>Chat</button>
          <button type="button" onClick={() => setMode("reader")} style={S.modeBtn(mode === "reader")}>6-Pack Reader</button>
          <button type="button" onClick={forget} style={{ ...S.modeBtn(false), marginLeft: "auto", color: "#f85149" }}>
            Stop and forget
          </button>
        </div>
        <div style={{ fontSize: 12, color: "#8b949e", lineHeight: 1.5 }}>
          Civic AI Kami runs on your community GPU. It can discuss the 6-Pack of Care,
          civic concepts, and how this Pod works. It does <strong>not</strong> see your Pod
          data — to look at your submissions, journal, behaviors, or traits, use the{" "}
          <strong>Explore</strong> tab. Conversations are mirrored to your Personal Pod and
          wiped on sign-out. The cooperative logs counts only.
        </div>
      </div>
      <div style={S.body}>
        {mode === "reader" ? (
          <CivicAiReader />
        ) : (
          <>
            <div ref={transcriptRef} style={S.transcript}>
              {messages.length === 0 && (
                <div style={{ color: "#484f58", fontSize: 12, lineHeight: 1.6, maxWidth: 640 }}>
                  Ask the Kami about the 6-Pack of Care, a civic concept, or how this Pod works.
                  For questions about your own data, switch to the <strong>Explore</strong> tab —
                  the Kami cannot see your saved rows.
                </div>
              )}
              {messages.map((msg) => (
                <div key={msg.id} style={S.bubble(msg.role)}>
                  <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 4 }}>
                    {msg.role === "user" ? "You" : "Civic AI Kami"}
                  </div>
                  {msg.content || (busy && msg.role === "assistant" ? "Thinking..." : "")}
                </div>
              ))}
            </div>
            {status && (
              <div style={{ marginTop: 10, color: status.ok ? "#3fb950" : "#f85149", fontSize: 12 }}>
                {status.text}
              </div>
            )}
            <div style={S.inputRow}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) send();
                }}
                placeholder="Ask your local Civic AI Kami..."
                style={S.input}
              />
              <button type="button" onClick={send} disabled={busy || !input.trim()} style={S.sendBtn(busy || !input.trim())}>
                {busy ? "Streaming..." : "Send"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
