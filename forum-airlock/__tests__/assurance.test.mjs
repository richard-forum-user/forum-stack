// Run: node --experimental-sqlite forum-airlock/__tests__/assurance.test.mjs
// Assurance tiers: paid checkout, Stripe webhook verification, per-card cap,
// refund revocation, tier at ingest, tier counts in the report. No network:
// Stripe API calls are stubbed, D1 is an in-memory SQLite shim.
import { DatabaseSync } from "node:sqlite";
import { handleMembershipRoute } from "../membership.js";
import { tierForSubmission, verifyStripeSignature, _resetAssuranceSchemaFlag, ensureAssuranceSchema } from "../assurance.js";
import { collectLedgerFromD1, buildFaithfulReport } from "../civic-analysis.js";

let fails = 0;
const check = (n, c, d = "") => { console.log(`${c ? "[ok]" : "[FAIL]"} ${n}${c ? "" : " " + d}`); if (!c) fails++; };

// ---- D1 shim ----
function d1(sqlite) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => { const r = sqlite.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`CREATE TABLE forum_feedback (receipt_id TEXT PRIMARY KEY, kind TEXT, category_code TEXT,
  category_label TEXT, zip_code TEXT, comment TEXT, email_hash TEXT, consent_at TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, wiped_at TEXT, contest_window_ends_at TEXT)`);
const DB = d1(sqlite);

// ---- keys / signed bundles ----
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
async function newPod() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pub = hex(await crypto.subtle.exportKey("raw", kp.publicKey));
  return {
    pub,
    async sign(payload) {
      const sessionId = "s-" + pub.slice(0, 8);
      const timestamp = new Date().toISOString();
      const sorted = {}; for (const k of ["payload", "sessionId", "timestamp"]) sorted[k] = { payload, sessionId, timestamp }[k];
      const sig = await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(JSON.stringify(sorted)));
      return { payload, sessionId, timestamp, signature: hex(sig), publicKeyHex: pub };
    },
  };
}

// ---- Stripe stub ----
const charges = {}; // payment_intent -> charge
let lastCheckoutParams = null;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.endsWith("/v1/checkout/sessions")) {
    lastCheckoutParams = new URLSearchParams(init.body);
    return new Response(JSON.stringify({ id: "cs_" + Math.random().toString(36).slice(2), url: "https://checkout.stripe.test/x" }), { status: 200 });
  }
  const m = u.match(/payment_intents\/([^?]+)/);
  if (m) return new Response(JSON.stringify({ id: m[1], latest_charge: charges[m[1]] }), { status: 200 });
  throw new Error("unexpected fetch " + u);
};

const SECRET = "whsec_test";
const env = { DB, STRIPE_SECRET_KEY: "sk_test", STRIPE_MEMBERSHIP_PRICE_ID: "price_1", STRIPE_WEBHOOK_SECRET: SECRET,
  ALLOW_DEV_MEMBERSHIP: "1", MEMBER_HASH_SALT: "salt", MAX_PAID_KEYS_PER_CARD: "2" };
const call = (path, body, headers = {}) =>
  handleMembershipRoute(new Request("https://coop" + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }), env, new URL("https://coop" + path));

async function stripeSig(raw, t = Math.floor(Date.now() / 1000), secret = SECRET) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `t=${t},v1=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`)))}`;
}
async function pay(pod, { pi, fingerprint, zip, postal = "pass" }) {
  const signed = await pod.sign({ action: "paid_membership_checkout" });
  const r = await call("/membership/checkout", signed);
  const keyHash = lastCheckoutParams.get("metadata[key_hash]");
  charges[pi] = { billing_details: { address: { postal_code: zip } }, payment_method_details: { card: { fingerprint, checks: { address_postal_code_check: postal } } } };
  const raw = JSON.stringify({ type: "checkout.session.completed", data: { object: { id: "cs_" + pi, payment_status: "paid", payment_intent: pi, client_reference_id: keyHash, metadata: { purpose: "paid_membership", key_hash: keyHash } } } });
  const w = await call("/membership/stripe-webhook", raw, { "Stripe-Signature": await stripeSig(raw) });
  return { checkout: r, webhook: w, body: await w.json() };
}

// 1. Checkout requires a valid signed bundle
let r = await call("/membership/checkout", { payload: { action: "paid_membership_checkout" }, sessionId: "x", timestamp: new Date().toISOString(), signature: "00", publicKeyHex: "11".repeat(32) });
check("checkout rejects bad signature", r.status === 401, String(r.status));

// 2. Paid, ZIP matches
const alice = await newPod();
let p = await pay(alice, { pi: "pi_a", fingerprint: "fp_card1", zip: "04101" });
check("checkout returns Stripe URL", p.checkout.status === 200);
check("webhook records paid key", p.body.recorded === true, JSON.stringify(p.body));
check("tier paid_zip_match when ZIP matches", (await tierForSubmission(DB, alice.pub, "04101")) === "paid_zip_match");
check("tier paid when ZIP differs", (await tierForSubmission(DB, alice.pub, "04240")) === "paid");

// 3. Unpaid key
const mallory = await newPod();
check("unpaid key is unverified", (await tierForSubmission(DB, mallory.pub, "04101")) === "unverified");

// 4. Postal check failed -> paid only
const bob = await newPod();
await pay(bob, { pi: "pi_b", fingerprint: "fp_card2", zip: "04101", postal: "fail" });
check("failed postal check gives paid, not zip match", (await tierForSubmission(DB, bob.pub, "04101")) === "paid");

// 5. Card cap: card1 already used by alice; 2nd key ok, 3rd over limit
const c2 = await newPod(), c3 = await newPod();
await pay(c2, { pi: "pi_c2", fingerprint: "fp_card1", zip: "04101" });
p = await pay(c3, { pi: "pi_c3", fingerprint: "fp_card1", zip: "04101" });
check("second key on same card counted", (await tierForSubmission(DB, c2.pub, "04101")) === "paid_zip_match");
check("third key on same card over limit", p.body.over_card_limit === true && (await tierForSubmission(DB, c3.pub, "04101")) === "unverified");

// 6. Refund revokes
let raw = JSON.stringify({ type: "charge.refunded", data: { object: { payment_intent: "pi_a" } } });
await call("/membership/stripe-webhook", raw, { "Stripe-Signature": await stripeSig(raw) });
check("refund revokes paid tier", (await tierForSubmission(DB, alice.pub, "04101")) === "unverified");

// 7. Forged / stale webhooks rejected
raw = JSON.stringify({ type: "checkout.session.completed", data: { object: {} } });
r = await call("/membership/stripe-webhook", raw, { "Stripe-Signature": await stripeSig(raw, undefined, "wrong") });
check("webhook with wrong secret rejected", r.status === 400);
r = await call("/membership/stripe-webhook", raw, {});
check("webhook without signature rejected", r.status === 400);
r = await call("/membership/stripe-webhook", raw, { "Stripe-Signature": await stripeSig(raw, Math.floor(Date.now() / 1000) - 3600) });
check("stale webhook rejected", r.status === 400);
const noSecret = { ...env, STRIPE_WEBHOOK_SECRET: "" };
r = await handleMembershipRoute(new Request("https://coop/membership/stripe-webhook", { method: "POST", body: raw }), noSecret, new URL("https://coop/membership/stripe-webhook"));
check("webhook refused when secret not configured", r.status === 503);

// 8. Report counts by tier
sqlite.exec(`INSERT INTO forum_feedback (receipt_id,kind,category_code,category_label,zip_code,comment,email_hash,consent_at,assurance_tier) VALUES
  ('r1','civic','c','C','04101','x','h1','t','paid_zip_match'),
  ('r2','civic','c','C','04101','x','h2','t','paid'),
  ('r3','civic','c','C','04101','x','h3','t','unverified'),
  ('r4','civic','c','C','04101','x','h3','t','unverified')`);
const ledger = await collectLedgerFromD1(DB, {});
check("byTier counts", ledger.byTier.paid_zip_match.submissions === 1 && ledger.byTier.paid.submissions === 1 &&
  ledger.byTier.unverified.submissions === 2 && ledger.byTier.unverified.participants === 1, JSON.stringify(ledger.byTier));
const text = buildFaithfulReport(ledger, "rep");
check("report shows tier section", /By assurance tier/.test(text) && /Paid member: 1 submission/.test(text));

console.log(fails ? `\n${fails} FAILED` : "\nALL ASSURANCE TESTS PASSED");
process.exit(fails ? 1 : 0);
