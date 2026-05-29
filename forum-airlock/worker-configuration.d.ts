/** Generated/maintained for Wrangler bindings — run `npm run types` to refresh. */
interface Env {
  ALLOW_PILOT_BUNDLES: string;
  ALLOW_DEV_CIVIC_PUBLISH: string;
  CIVIC_PUBLISH_VERBATIM_COMMENTS: string;
  WEBAUTHN_ALLOWED_ORIGINS: string;
  // Civic AI Kami: retired by default; set as vars/secrets to re-enable.
  AI_UPSTREAM_URL?: string;
  AI_UPSTREAM_MODEL?: string;
  AI_DAILY_QUOTA: string;
  CIVIC_ANALYSIS_MIN_SUBMISSIONS: string;
  FORUM_AUTO_EDGE_ANALYSIS?: string;
  UNLOCK_TOKEN_KEY?: string;
  AIRLOCK_SECRET?: string;
  FORUM_SECRET?: string;
  FORUM_EGRESS_URL?: string;
  AI_ACCESS_CLIENT_ID?: string;
  AI_ACCESS_CLIENT_SECRET?: string;
  MEMBER_HASH_SALT?: string;
  CIVIC_CYCLE_SALT?: string;
  DB: D1Database;
  RECOVERY: DurableObjectNamespace;
  POD: DurableObjectNamespace;
  ASSETS: Fetcher;
  AI: Ai;
}
