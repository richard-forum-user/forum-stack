/**
 * In-process Pod adapter for Android / iOS via @capacitor-community/sqlite.
 * No network. Replays the DO dispatch logic locally.
 */

import { runPodDispatch, initPodSchemaSqlite } from "./pod-core.js";
import { loadMemberProfile, loadSigningMeta } from "./member-store.js";

const DB_NAME = "forum_personal_pod";
const SESSION_STORAGE_KEY = "forum.solidSession";

function loadSessionMeta() {
  try {
    const raw =
      typeof localStorage !== "undefined" && localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
let _sqliteHandle = null;
let _schemaReady = false;

async function getSqlite() {
  if (_sqliteHandle) return _sqliteHandle;
  const mod = await import("@capacitor-community/sqlite");
  const { CapacitorSQLite, SQLiteConnection } = mod;
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const isConn = (await sqlite.isConnection(DB_NAME, false)).result;
  if (isConn) {
    _sqliteHandle = await sqlite.retrieveConnection(DB_NAME, false);
  } else {
    _sqliteHandle = await sqlite.createConnection(
      DB_NAME,
      false,
      "no-encryption",
      1,
      false
    );
    await _sqliteHandle.open();
  }
  return _sqliteHandle;
}

function resolveSessionId() {
  const session = loadSessionMeta();
  if (session?.sessionId) return session.sessionId;
  const signing = loadSigningMeta();
  if (signing?.sessionId) return signing.sessionId;
  const profile = loadMemberProfile();
  return profile?.sessionId || null;
}

function wrapDb(db) {
  return {
    async exec(sql) {
      await db.execute(sql);
    },
    async run(sql, params = []) {
      await db.run(sql, params);
    },
    async all(sql, params = []) {
      const res = await db.query(sql, params);
      return res.values || [];
    },
    async get(sql, params = []) {
      const rows = await this.all(sql, params);
      return rows[0] || null;
    },
  };
}

export async function createCapacitorAdapter() {
  return {
    kind: "capacitor",
    providerUrl() {
      return "local://" + DB_NAME;
    },
    async rpc(verb, path, data = null) {
      const db = wrapDb(await getSqlite());
      if (!_schemaReady) {
        await initPodSchemaSqlite(db);
        _schemaReady = true;
      }
      const sessionId = resolveSessionId();
      if (!sessionId) {
        throw new Error("Sign in to your Pod first.");
      }
      const result = await runPodDispatch(db, {
        sessionId,
        verb,
        path,
        data: data || {},
      });
      if (result.status >= 400) {
        const reason = result.body?.reason || result.body?.error || "pod_error";
        throw new Error(`Pod RPC ${verb} ${path} failed (${result.status}): ${reason}`);
      }
      return result.body;
    },
  };
}
