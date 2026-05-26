# Handover 13 — Pod as the single source of truth (assistant rebind)

Build target: `secure-pod-v1.9-civic-ai` (no APK version bump — the
sessionId binding from H11 is unchanged).
Worker version deployed: `809232b6-ab49-43ac-97fa-a2af499c6e37`.
Prior: [12-civic-ai.md](12-civic-ai.md), [handover11-security-hardening.md](handover11-security-hardening.md).

This handover does one architectural thing: it pulls the only user
datum that was still living outside the Personal Pod DO — the Civic AI
Kami chat history — into the Pod, so the H6 invariant ("Pod is the
source of truth, no Pod no app") holds across every user-visible
surface.

## 1. Why this was needed

The H6/H8/H11 line is "Pod-first, then local cache." Everything in
the Pod DO already followed it (civic submissions, journal entries,
behaviors, traits, email proof). The Civic AI Kami shipped in H12
quietly broke it: `forum-pod/src/assistant-store.js` opened a separate
IndexedDB (`forum-civic-ai-assistant`) and never spoke to the DO.
Consequences before this change:

- **Sign-out did not wipe chat history.** The H6 contract says sign-out
  drops the local cache; civic data survives in the Pod and rehydrates
  on the next sign-in. Assistant conversations had no Pod copy, so
  signing out either left them behind (cache not cleared — bug already
  fixed in `handleSignOut` but only for IDB) or destroyed them
  permanently with no rehydration path.
- **Multi-device users lost chat history.** A second device signed in
  with the same passkey-bound Pod saw an empty Assistant tab. Civic
  rows hydrated from the Pod DO; assistant rows had no Pod row to
  hydrate from.
- **The "secure-pod-v1.9-civic-ai" mental model lied.** The Assistant
  header said "Conversations live only in this device's IndexedDB.
  Server logs counts only." which is true for prompt *content* (still
  is — see §4) but presented chat history as if it were comparable to
  Pod data. It was not.

User intent that prompted the change:

> I want the users pod database to be the single source of truth.

After scoping, the decision was: move assistant conversations into
the Pod, and on sign-out wipe the Pod copy too (not just the cache).
AI quota and usage logs (D1 `ai_chat_quota`, `ai_chat_log`) stay in
D1 because they are cooperative enforcement state, not user data.
Cooperative `forum_feedback` rows stay in D1 because they are by
design the cooperative's opt-in mirror, not a competing source of
truth for the user.

## 2. What changed (file by file)

### Personal Pod DO

| File | Change |
|------|--------|
| `forum-airlock/pod-do.js` | New `assistant_messages` table + `idx_assistant_msgs_conv_time` index in `initSchema()`. New dispatch routes (verb/path): `PUT /assistant/conversations/{conv}/messages/{msg}`, `LIST /assistant/conversations/{conv}/messages`, `LIST /assistant/conversations`, `DELETE /assistant/conversations/{conv}`, `DELETE /assistant/conversations`. All five reuse the existing auth path (assertSessionBinding → assertUnlocked → verifySignedBundle → checkAndRecordReplay). No new migration: the `CREATE TABLE IF NOT EXISTS` fires lazily on the next DO instantiation, same pattern used for `replay_cache` in H9. |

### Pod app — write/sync helpers

| File | Change |
|------|--------|
| `forum-pod/src/solid-pod-write.js` | New `writeAssistantMessageToPod(conversationId, message)`, `deleteAssistantConversationFromPod(conversationId)`, `deleteAllAssistantConversationsFromPod()`. Each calls `podRpc(...)` and so picks up the H11 sessionId binding + unlock-token enrichment via `signing-envelope.js` automatically. |
| `forum-pod/src/solid-sync.js` | New `syncAssistantConversationFromPod(conversationId = "default")` returns rows shaped for the existing IDB schema (`{ id, role, content, created_at }`). |
| `forum-pod/src/pod-solid-integration.js` | Re-exports the three new helpers so `pod-ui.jsx` and `assistant.jsx` import from a single surface. |

### Pod app — UI

| File | Change |
|------|--------|
| `forum-pod/src/assistant.jsx` | (1) Boot effect now reads from the Pod first (`syncAssistantConversationFromPod`) and mirrors into IDB; on Pod-read failure, falls back to the IDB cache with a yellow status banner so the user is not stranded. (2) `send()` writes the user message to the Pod **before** calling Ollama; if the Pod write fails the model is never invoked. After streaming completes, the final assistant message is also written to the Pod. (3) `forget()` calls `deleteAssistantConversationFromPod(TOPIC)` before clearing the IDB. (4) Header copy now states: "Conversations live in your Personal Pod (Cloudflare Durable Object) — this device only caches them." |
| `forum-pod/src/pod-ui.jsx` | `handleSignOut` now calls `deleteAllAssistantConversationsFromPod()` before the existing `clearAllPodData()` + `clearAllAssistantConversations()`. Pod wipe failure does not block sign-out; the user gets a status message so they know there may be a residual Pod copy. |

### What did *not* change

- Wire format. The signed bundle, sessionId binding, unlock token, and
  replay protection are exactly as in H11. The new DO routes ride on
  the same authentication path.
- D1 `ai_chat_quota` and `ai_chat_log` (cooperative usage stats).
- D1 `forum_feedback` (cooperative opt-in ledger).
- D1 `webauthn_credentials`, `edge_signing_keys` (protocol state).
- localStorage `forum.podSigning` + `forum.member` (device-bound key
  material; must never leave the device).
- `AI_UPSTREAM_MODEL = "qwen2.5:14b-instruct-q4_K_M"` (fix from earlier
  today; the previously misnamed `qwen2.5:14b-instruct` 404'd Ollama
  and produced the bare "Civic AI Kami" empty-bubble symptom).

## 3. New wire routes

All five go through `/api/pod/*` and require the v1.8 signed-and-bound
envelope (`sessionId = pubkey:sha256(publicKeyHex)`, `deviceCredentialId`,
optional `unlockToken`).

| Verb | Path | Body | Returns |
|------|------|------|---------|
| `PUT` | `/assistant/conversations/{conv}/messages/{msg}` | `{ role, content, created_at? }` | `{ ok, conversation_id, message_id }` |
| `LIST` | `/assistant/conversations/{conv}/messages` | — | `{ rows: [{ conversation_id, message_id, role, content, created_at, updated_at }, ...] }` |
| `LIST` | `/assistant/conversations` | — | `{ rows: [{ conversation_id, message_count, last_updated_at }, ...] }` |
| `DELETE` | `/assistant/conversations/{conv}` | — | `{ ok, deleted }` |
| `DELETE` | `/assistant/conversations` | — | `{ ok, deleted }` |

Conversation IDs and message IDs are URL-encoded in the path; the DO
URL-decodes both before keying the row. Today only `conversation_id = "default"`
is used (the Assistant component hard-codes `TOPIC = "default"`),
but the schema is multi-conversation ready.

## 4. Privacy posture

The cooperative now has strictly fewer things it can see:

- Worker still **only logs counts** for AI chat (`ai_chat_log` writes
  `prompt_eval_count`, `eval_count`, `finish_reason` — no text).
- Conversation content lives in two places: the Pod DO (per-device,
  SQLite, encrypted at rest by Cloudflare), and the device IndexedDB
  cache. Cooperative D1 contains zero conversation content.
- On sign-out, both copies are wiped. Negative test: sign in, send a
  message, sign out, sign back in → Assistant transcript is empty.
- The Worker proxies one request body (the user's latest message + the
  H12 system prompt) to Ollama on every send. That is unchanged from
  H12 and is the smallest amount of data we can hand the model.

## 5. Verification (recorded against deploy `809232b6`)

Build + deploy:

```bash
cd ~/Desktop/forum-pod
npm run lint    # exits 0
npm run build   # exits 0

cd ~/Desktop/forum-airlock
npx wrangler deploy   # Current Version ID: 809232b6-...
```

Smoke tests to run on the phone after installing the rebuild:

1. Open Assistant → send a message → confirm streaming reply, no 502.
2. Reload the page (or kill/restart the APK) → confirm the message
   pair reappears in the transcript (proves Pod hydration on boot).
3. `wrangler tail secure-worker --search "/api/pod"` should show two
   `POST /api/pod` lines per send (one for the user message,
   one for the assistant reply).
4. **Sign-out test:** Settings → Sign out (lock — keeps device key) →
   sign back in → Assistant tab should be empty. (This is the H13
   behavior the user explicitly asked for.)
5. **Multi-device test (manual, optional):** export the device key
   blob with a PIN (Settings → Device key → Export), import on a
   second device, sign in there, open Assistant. The transcript
   should be empty *only because* sign-out on device 1 wipes the Pod
   copy; if you skip sign-out on device 1, device 2 should see the
   conversation. (If the user later changes the sign-out policy from
   "wipe" to "survive", this test becomes the primary regression
   guard.)
6. **Negative test:** stop the Worker (or unbind the DO) before
   sending. The Assistant should refuse to call Ollama because the
   Pod-first user-message write fails; status banner reads "Could not
   save message to Pod: ...".

## 6. Known follow-ups

| Item | Notes |
|------|-------|
| Move AI quota and usage log into the Pod (Phase 2 from the audit) | Currently `ai_chat_quota` and `ai_chat_log` live in D1, accessible to the cooperative for enforcement. If the user later wants a Pod-side mirror so they can see their own usage from inside the Pod without trusting D1 reads, the cleanest place is a new `ai_usage` table in `pod-do.js` and a write hook in `forum-airlock/ai-chat.js` after `writeAiLog`. |
| Multi-conversation UX | The schema supports it but the Assistant component only uses `conversation_id = "default"`. Easy follow-up: per-topic conversations, a sidebar of recent threads, etc. |
| Pod read-failure during boot | `assistant.jsx` falls back to the IDB cache and shows a yellow status. If you'd rather it surface a hard error and refuse to show any history at all (matching the civic invariant on the Forum Submissions tab), tighten the fallback in the boot effect. |
| Sign-out-wipe behavior is sticky | Per the user's choice the Pod copy is deleted on sign-out, not just the cache. If they ever flip to "survive," remove the `deleteAllAssistantConversationsFromPod` call from `handleSignOut` and the test in §5 step 4 becomes "transcript should rehydrate." |
| Update Handover 12's "Conversations live only in this device's IndexedDB" line | The phrase is now stale. Either edit H12 in place or treat this handover as the correction; I left H12 untouched to preserve historical accuracy. |
| `npm install --save-dev wrangler@4` upgrade | Wrangler is still on v3 and warning on every deploy. Non-blocking. |

## 7. Mental model for the next agent

```
Pod DO (PersonalPodDO, SQLite) = source of truth for ALL user data:
  civic_submissions, journal_entries, behaviors, traits,
  email_proof, AND assistant_messages

IndexedDB (forum-personal-pod, forum-civic-ai-assistant) = caches:
  hydrated from Pod on sign-in
  written through after every Pod write
  wiped on sign-out (assistant cache wipe was already there;
                     Pod-side wipe is new in H13)

D1 forum-db = cooperative ledger:
  forum_feedback (opt-in shares, not user-private)
  ai_chat_quota + ai_chat_log (counts only, enforcement)
  webauthn_credentials, edge_signing_keys (protocol)

localStorage = device-bound key material:
  forum.podSigning (private signing key)
  forum.member (cosmetic profile)
  forum.podProviderUrl (override)
  in-memory unlock token (volatile, never persisted)
```

If a future change introduces a third place that user-private data
lands (e.g. a "drafts" feature that writes to IDB only), audit it
against this list before merging. The invariant: every row a user
might recognise as "theirs" should live in the Pod DO, and the rest
of the stack should be caches or cooperative-public.

## 8. Addendum — Civic AI Kami can now read Pod data

Worker version deployed: `520a2817-c0cc-48d1-8be2-bc65d994ff38`
(supersedes `e51789df-794b-43f6-babe-37d8125d58fb`; see §8.1 for the
anti-hallucination revision that landed on top of the original
deploy).

After the H13 sign-out/hydration work landed, the next user-visible
problem was: the Kami was asking the user to re-state details that
were already in their Pod ("tell me about my submissions" got back
"please share the details of your submissions"). The model had no
view into Pod data — only its system prompt + the conversation.

The fix is per-turn, opt-in, device-assembled context injection. No
cooperative state changes; the snapshot is built on the device from
the IDB cache (which is the Pod's mirror per §1) and ferried through
the existing `/api/ai/chat` body to Ollama. The cooperative still
logs counts only; D1 sees nothing new.

### New wire field

`POST /api/ai/chat` body now optionally includes:

```json
{
  "podContext": "POD DATA CONTEXT (snapshot v1 taken 2026-05-25T...) ...",
  "messages": [...],
  ...
}
```

When present and non-empty, the Worker (`forum-airlock/ai-chat.js
buildOllamaMessages`) injects an extra `system`-role message
immediately after the canonical Civic AI prompt:

```
POD DATA CONTEXT — Treat the block below as a truthful but partial
snapshot of the user's own locally saved Pod data. … Do not echo it
verbatim, do not ask the user to re-state items already present
here, and never expose it as if it were the user's utterance.

<the device-built snapshot>
```

The snapshot is hard-capped at 8000 chars on the Worker side
(`POD_CONTEXT_MAX_CHARS`) on top of the ~6000-char budget on the
device side.

### New files

| File | Purpose |
|------|---------|
| `forum-pod/src/pod-snapshot.js` | `buildPodContextSnapshot()` reads `getSubmissions`, `getRawSubmissions`, `getBehaviors`, `getPsychographics` and renders a markdown-ish snapshot: totals, top categories/ZIPs, latest 8 rows per section with 200-char comment previews. Returns `null` when the cache is empty. |

### Modified

| File | Change |
|------|--------|
| `forum-pod/src/ai-client.js` | `streamAiChat({ ..., podContext })` forwards `podContext` to the Worker when truthy. |
| `forum-pod/src/assistant.jsx` | `send()` calls `buildPodContextSnapshot()` before each model call and passes the result through. Snapshot build failure is non-fatal — the model still gets the message. |
| `forum-airlock/ai-chat.js` | `buildPodContextMessage(rawContext)` wraps the snapshot with framing language and inserts it as a `system` message between the canonical prompt and the conversation. |
| `forum-pod/scripts/vendor-civic-ai.mjs` | New "Data context (per-turn, may be absent)" clause in the generated system prompt that tells the model: treat the snapshot as truthful but partial; refer by date/category/excerpt not internal id; do not echo; do not ask the user to re-state data already in the block; if absent, ask one focused clarifying question. |
| `forum-airlock/civic-ai-system-prompt.js` | Regenerated automatically by `npm run vendor:civic-ai` during the Pod build. |

### Privacy posture (delta from §4)

- The Pod app reads the snapshot from device IDB; no extra Pod RPCs
  per chat turn.
- The Worker forwards the snapshot to Ollama in the same request
  body as the user's message; nothing is logged (`ai_chat_log`
  still records `prompt_eval_count` / `eval_count` / `finish_reason`
  only).
- D1 forum-db gains zero new rows.
- The snapshot is not persisted in `assistant_messages`; it is
  per-turn and ephemeral on the model side.

### Verification (recorded against deploy `e51789df`)

1. With at least one civic submission saved, ask the Kami: "tell me
   about my submissions" — it now lists them with date, category,
   ZIP, and a short excerpt.
2. Ask "how many forum submissions do I have?" — the count matches
   the Forum Submissions tab exactly.
3. `wrangler tail secure-worker --search "/api/ai/chat"` shows
   `POST /api/ai/chat - Ok` with no body content captured. Nothing
   appears in `wrangler d1 execute forum-db --remote --command
   "SELECT * FROM ai_chat_log ORDER BY id DESC LIMIT 5"` beyond the
   pre-existing count rows.
4. Sign out → sign back in → ask "tell me about my submissions"
   again. After hydration, the Kami still answers correctly (because
   the IDB cache was repopulated from the Pod DO).
5. Brand-new Pod with no rows: the Kami says it doesn't see any saved
   data yet and asks one focused clarifying question instead of
   inventing rows.

### Known follow-ups (delta)

| Item | Notes |
|------|-------|
| Snapshot freshness across multi-turn conversations | Currently every turn re-snapshots from IDB. If the user adds a submission mid-conversation, the next turn will see it. That's the right behavior; just noting it for awareness. |
| Token cost | Every chat turn sends ~1–6 KB of context. With Ollama on the cooperative GPU, this is free; if we ever route to a paid model, batch or summarise. |
| "Fetch this specific item in full" | The snapshot truncates comments to 200 chars. If the user asks the Kami to elaborate on a row, the Kami currently can't fetch the full text. A follow-up: a tool-use round-trip (or a "show me row X" command that re-snapshots only that row at full length). |
| Server-side opt-in toggle | If a user later wants the Kami to not see Pod data at all, expose a Settings toggle that suppresses `buildPodContextSnapshot` and tells the Kami "context disabled for this session." |

## 8.1 Addendum — Anti-hallucination + always-on snapshot

Worker version deployed: `520a2817-c0cc-48d1-8be2-bc65d994ff38`.

After the §8 deploy, the user reported two new symptoms in the
Assistant tab:

1. **Aggressive hallucination.** The Kami invented submissions,
   dates, ZIPs, and category labels that did not exist in the Pod.
2. **Kami asking the user for "pod context".** The model misread the
   v1.9 prompt language ("the platform may attach a context message
   ... may be absent") as instructions that the *user* was supposed
   to type or paste a context block. It would respond to "tell me
   about my submissions" with things like "Please share your pod
   context so I can review it."

Two root causes:

- The snapshot helper returned `null` when the Pod cache was empty,
  so the Worker injected no context message at all. The model still
  saw the system-prompt clause that promised a block "may exist" and
  went looking for it.
- The v1.9 wrap text in `forum-airlock/ai-chat.js buildPodContextMessage`
  ("Treat the block below as a truthful but partial snapshot ... may
  be absent") plus the matching system-prompt clause was soft enough
  that the model coerced it into "ask the user for the block."

### Fix

Three coordinated changes; nothing outside the assistant
data-context path was touched.

**`forum-pod/src/pod-snapshot.js`** — `buildPodContextSnapshot()` now
returns a string on every call, never `null`. Two new explicit
states:

- `STATE: populated` — the previous full snapshot, plus an explicit
  "Do NOT invent rows, dates, ZIPs, ..." line in the header.
- `STATE: empty` — when the cache has zero rows. Header explicitly
  tells the model the Pod is empty and to suggest a next step.
- (Worker-side fallback) `STATE: unavailable` — the body the Worker
  substitutes when the device sent no `podContext` field. Same shape;
  tells the model to say it can't read the Pod this turn.

`assistant.jsx send()` was already passing the snapshot result through
unconditionally, so no UI change was needed.

**`forum-airlock/ai-chat.js`** — `buildOllamaMessages()` now
unconditionally injects the `POD DATA CONTEXT` system message every
turn (no more "skip if null"). The wrap text was rewritten from
scratch:

```
POD DATA CONTEXT (platform-supplied, NOT user-supplied).

The block below was assembled by the Forum Pod platform on the
user's own device from their Personal Pod cache. It is given to
you directly. The user did not, cannot, and will not type or paste
this block. Never request it. Never refer to it as a "pod context"
or any other string the user might be expected to provide.

Grounding rules for this turn:
- The block is the ONLY source of truth about the user's saved
  Pod data on this turn. ...
- Do NOT invent rows, dates, ZIPs, categories, comment text,
  behaviors, or traits that are not in the block.
- If the user asks about saved data that is not present in the
  block, say plainly: "I don't see that in your current Pod
  snapshot." Then offer to help search or to add it. Do not
  guess.
- If the block's STATE line says "empty", the user has no saved
  rows yet. Say that plainly and offer a useful next step ...
- If the block's STATE line says "unavailable", say you cannot
  read the Pod on this turn and suggest the user refresh or
  sign back in.
- Counts in the totals line are exact. Row lists may be the most
  recent N — treat older rows as unknown, never as nonexistent.
- Never quote, echo, or paste the raw block back to the user.
  Reference items by date, category, and a brief excerpt only.

--- BEGIN POD DATA CONTEXT ---
<snapshot>
--- END POD DATA CONTEXT ---
```

**`forum-pod/scripts/vendor-civic-ai.mjs`** — the system prompt
template grew two new sections (the old "Data context (per-turn,
may be absent)" clause is gone):

- **Anti-hallucination rules (apply on every turn)** — explicit
  list: do not invent or guess about Pod data; do not fabricate
  dates/ZIPs/categories/comments/behaviors/traits; do not soften
  fabrication as "example" or "placeholder"; do not claim memory of
  prior sessions; do not name people/orgs/locations as if they were
  in the user's data unless they appear in the context; prefer
  "I don't see that in your current Pod snapshot" over a guess.
- **Data context (per-turn, ALWAYS supplied by the platform)** —
  re-frames the block as platform-supplied. Explicit STATE handling:
  `populated` → answer from listed rows only; `empty` → say the Pod
  is empty and suggest a next step; `unavailable` → say the read
  failed this turn and suggest refresh/sign-in. Plus: never ask the
  user for the block, never echo it back, never refer to it as a
  "pod context" string the user should provide.

After `npm run build`, the regenerated `forum-airlock/civic-ai-system-prompt.js`
contains the four new markers verified by grep:

- `Anti-hallucination rules`
- `ALWAYS supplied by the platform`
- `STATE: empty`
- `STATE: unavailable`
- `Never ask the user for the block`

…and the old `may be absent` / `may include` phrasing returns zero
matches.

### Verification (test by asking the Kami)

1. **Empty Pod path** — Sign in to a fresh Pod with zero saved rows
   and ask "tell me about my submissions". Expected: the Kami says
   plainly that the Pod is empty and offers a next step (e.g.
   "would you like to make a Forum Submission?"), without asking
   the user for a "pod context".
2. **Populated Pod path** — Save one Forum Submission, then ask
   "tell me about my submissions". Expected: the Kami lists it with
   date, category, ZIP, and a short excerpt, and does not invent
   any other rows.
3. **Out-of-snapshot path** — Ask the Kami about a person, date, or
   ZIP that does not appear in your data. Expected: "I don't see
   that in your current Pod snapshot" plus an offer to help.
4. **No-context-request path** — Ask "what can you see about me?".
   Expected: the Kami answers from the block; it must not ask the
   user to paste or supply a context string.

### Files touched (8.1 only)

- `forum-pod/src/pod-snapshot.js` — explicit STATE markers; never
  returns `null`.
- `forum-airlock/ai-chat.js` — wrap text rewrite, always-inject
  `buildOllamaMessages`, `POD_CONTEXT_UNAVAILABLE` fallback constant.
- `forum-pod/scripts/vendor-civic-ai.mjs` — new
  "Anti-hallucination rules" section + rewritten "Data context"
  clause. Regenerates `forum-pod/src/civic-ai/system-prompt.txt` and
  `forum-airlock/civic-ai-system-prompt.js` on next build.
- `forum-airlock/civic-ai-system-prompt.js` — auto-regenerated by
  `npm run build` (`npm run vendor:civic-ai && vite build`).
- `forum-pod/src/assistant.jsx` — no behavioral change in 8.1; the
  detour I started (a deterministic local-answer bypass) was reverted
  before the deploy so the Kami still goes through the model with the
  grounded context.

---

## §9 Regression: v1.9 grounded prompt still hallucinated. Pivot to Explore.

**Date**: 2026-05-25 (same evening as §8.1).

### What happened

After deploying §8.1 (always-inject POD DATA CONTEXT block, blunt
wrap text, anti-hallucination rules in the system prompt), the user
re-tested the Kami and reported it was still inventing rows:

> "It's still giving me fake answers based on journal submissions
> from 2023 that can't exist. We need to abandon the civicAI in the
> pod."

This was reproducible. The quantized 14B model on a small context
will fabricate adversarial-looking rows under every prompt variant
we tried in §8.1. We have to treat the LLM as structurally incapable
of answering questions about the user's saved data, not as
mis-prompted.

### Pivot

User intent (confirmed via in-chat questions):
1. **Keep the Kami alive** but cut its access to Pod data entirely.
   It can only discuss the 6-Pack of Care, civic concepts, and how
   the Pod works.
2. **Add a deterministic "Explore" tab** that lets the user ask
   questions about their data via preset SQL queries, with the
   exact query shown and a one-line factual summary built by
   string interpolation over the result set.
3. **Leave the Ollama / `/api/ai/chat` infrastructure** in place
   (no infra teardown), since the chat still uses it for general
   civic Q&A.

### Code changes in v2.0

**New: `forum-pod/src/explore.jsx`** — a sidebar of question
buttons grouped by data source (Totals, Forum Submissions, Journal,
Behaviors, Traits). Each button maps to one hand-written SQL
template. The component runs it against the DuckDB-WASM cache,
shows the exact SQL, the row count, the result table, and a
deterministic summary line computed from the rows (e.g. *"3
submissions across 2 categories. Most common: civic (2)."*). No
LLM is involved at any layer.

**Wired in: `forum-pod/src/pod-ui.jsx`** — new tab `explore`
sits between Forum Feedback and Import in the tab bar. Renders
`<Explore conn={conn}/>`.

**Stripped: `forum-pod/src/assistant.jsx`** —
- Removed `buildPodContextSnapshot` import + call site.
- `streamAiChat` is no longer passed a `podContext`.
- Header copy rewritten: the Kami can discuss the 6-Pack and how
  the Pod works, but cannot see Pod data; users are routed to the
  Explore tab for data questions.
- Empty-transcript hint rewritten to match.

**Stripped: `forum-pod/src/ai-client.js`** — `streamAiChat`
no longer accepts or forwards a `podContext` field.

**Deleted: `forum-pod/src/pod-snapshot.js`** — the per-turn
snapshot builder is gone. It existed only to feed the chat path;
the Explore tab reads DuckDB directly.

**Stripped: `forum-airlock/ai-chat.js`** — removed
`POD_CONTEXT_MAX_CHARS`, `POD_CONTEXT_UNAVAILABLE`,
`buildPodContextMessage`. `buildOllamaMessages` now returns just
the canonical system prompt plus normalized turns. Older Pod
builds that still send `payload.podContext` have it silently
ignored.

**Rewrote: `forum-pod/scripts/vendor-civic-ai.mjs`** — the
"Anti-hallucination rules" and "Data context (per-turn, ALWAYS
supplied by the platform)" sections are replaced by a single
section titled **"You do NOT have access to the user's Pod data"**
followed by **"What you CAN help with"** (6-Pack, civic concepts,
Pod mechanics, reflective questions). Regenerates
`forum-pod/src/civic-ai/system-prompt.txt` and
`forum-airlock/civic-ai-system-prompt.js` on `npm run build`.

### Deploy

- Worker version ID: `e69b998f-3d17-48d5-bca2-6e413c4fbc8f`.
- Pod app rebuilt with `npm run build` (vendor:civic-ai → vite build).
- ESLint clean; one `set-state-in-effect` warning suppressed in
  `explore.jsx` where it's intentional (auto-run first preset
  on connection).

### Files touched

- **Added**: `forum-pod/src/explore.jsx`
- **Modified**: `forum-pod/src/pod-ui.jsx` (import + tab list + render)
- **Modified**: `forum-pod/src/assistant.jsx`
- **Modified**: `forum-pod/src/ai-client.js`
- **Modified**: `forum-pod/scripts/vendor-civic-ai.mjs`
- **Modified**: `forum-airlock/ai-chat.js`
- **Regenerated**: `forum-pod/src/civic-ai/system-prompt.txt`
- **Regenerated**: `forum-airlock/civic-ai-system-prompt.js`
- **Deleted**: `forum-pod/src/pod-snapshot.js`

### Invariant change

Earlier handovers said "the cooperative logs counts only, never
message text **or Pod data**" for the chat path. v2.0 strengthens
this: the chat path **does not receive Pod data in the first
place**. The only surface that touches user rows is local —
the Pod DO, the DuckDB cache, and the Explore tab's SQL against
that cache. That is the only place where data answers can be
trusted, because it's the only place where data answers don't
pass through a model.

### What to test

1. Sign in. Open Explore tab. The "How many rows do I have, total?"
   query runs automatically and shows real counts.
2. Click each preset. Confirm the SQL displayed matches the table
   below it and the summary line uses values from the rows.
3. Open Assistant. Ask: "What's in my journal?" The Kami should
   refuse and redirect to Explore — no fabricated rows.
4. Ask the Kami a 6-Pack question (e.g. *"What does the
   Attentiveness pack mean?"*). It should answer normally.
