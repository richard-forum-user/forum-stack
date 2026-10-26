crypto.subtle.timingSafeEqual = (a, b) => { const x = new Uint8Array(a.buffer ?? a), y = new Uint8Array(b.buffer ?? b); if (x.length !== y.length) return false; let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0; };
// Run: node forum-airlock/__tests__/retention.test.mjs  (polyfills the Workers-only timingSafeEqual)
import { aggregateLedgerSummary, sanitizeReportMetadata, handleCivicAnalysisRoute } from "../civic-analysis.js";
import egress from "../../forum-egress/worker.js";

let fails = 0;
const check = (n, c, d = "") => { console.log(`${c ? "[ok]" : "[FAIL]"} ${n} ${c ? "" : d}`); if (!c) fails++; };

const rows = [{ receipt_id: "r1", kind: "civic", category_code: "c", category_label: "C", zip_code: "04101", comment_length: 5, consent_at: "t", created_at: "t" }];
const ledger = { total: 1, distinctParticipants: 1, byCategory: [{ category_code: "c", count: 1 }], zipPrefixCounts: { "041": 1 }, ledger: rows, sql: {}, maxCommentChars: 500 };
const leaks = (o) => /04101|"r1"|receipt_id/.test(JSON.stringify(o));

const sum = aggregateLedgerSummary(ledger);
check("summary drops row-level fields", !leaks(sum) && sum.total === 1 && sum.zipPrefixCounts["041"] === 1, JSON.stringify(sum));
check("old metadata sanitized", !leaks(sanitizeReportMetadata({ project: "x", ledger })));

// unauthenticated GET /ledger
const env = { DB: {}, AIRLOCK_SECRET: "s3cret" };
let res = await handleCivicAnalysisRoute(new Request("https://coop/api/civic/analysis/ledger"), env, new URL("https://coop/api/civic/analysis/ledger"));
check("GET /ledger without secret is 401", res.status === 401, String(res.status));

// egress strips rows + sets TTL
const puts = [];
const kv = { put: async (k, v, o) => puts.push({ k, v, o }), get: async () => null };
res = await egress.fetch(new Request("https://egress/", { method: "POST", headers: { "X-Forum-Secret": "f" }, body: JSON.stringify({ metadata: { timestamp: "T", status: "published", ledger }, report: "txt", extra: { receipt_id: "r1" } }) }), { FORUM_SECRET: "f", FORUM_REPORTS: kv, REPORT_TTL_DAYS: "90" });
check("egress accepted", res.status === 200, String(res.status));
check("egress stores no row-level data", puts.every((p) => !leaks(p.v)), JSON.stringify(puts.map((p) => p.v)));
check("snapshot key has TTL", puts.find((p) => p.k === "report_T")?.o?.expirationTtl === 90 * 86400);
check("latest has no TTL", !puts.find((p) => p.k === "latest")?.o);
console.log(fails ? `${fails} FAILED` : "ALL COOP TESTS PASSED");
process.exit(fails ? 1 : 0);
