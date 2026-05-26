const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { verifyBundle, registerPodKey } = require('./pod-signing');

const ROOT = __dirname;
const DESKTOP = path.resolve(ROOT, '..');
const CONFIG_PATH = path.join(DESKTOP, 'forum.config.env');
const AI_DB_PATH = path.join(DESKTOP, 'forum-ai', 'database_syncs', 'forum_inbound.db');

const CONFIG_KEYS_FROM_FILE = new Set([
  'AIRLOCK_SECRET',
  'FERNET_KEY',
  'LISTENER_PORT',
  'LISTENER_URL',
  'FORUM_AUTO_ANALYSIS',
  'LISTENER_CORS_ALLOWLIST',
]);

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return;
  for (const line of fs.readFileSync(CONFIG_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!key) continue;
    if (CONFIG_KEYS_FROM_FILE.has(key) || process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadConfig();

const app = express();
app.use(bodyParser.json({ limit: '50mb' }));

const DEFAULT_CORS_ORIGINS = new Set([
  'http://localhost:5173',
  'https://secure-worker.forum-community.workers.dev',
]);

function buildCorsAllowlist() {
  const list = new Set(DEFAULT_CORS_ORIGINS);
  const extra = (process.env.LISTENER_CORS_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const o of extra) list.add(o);
  return list;
}

const CORS_ALLOWLIST = buildCorsAllowlist();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ALLOWLIST.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-Airlock-Secret, X-Requested-With'
    );
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const dbPath = path.join(ROOT, 'forum_inbound.db');
const schemaPath = path.join(ROOT, 'schema.sql');
const vaultPath = path.join(DESKTOP, 'forum-ai', 'vault.py');
const analysisScript = path.join(DESKTOP, 'forum-ai', 'run_analysis.sh');

const podKeyRegistry = new Map();
const exportRateByWebId = new Map();

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Failed to connect to forum_inbound.db:', err);
  else console.log('Sovereign Node connected to physical ledger.');
});

function initSchema() {
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql, (err) => {
    if (err) console.error('Schema init failed:', err.message);
    else console.log('Airlock schema ready.');
  });
  for (const stmt of [
    'ALTER TABLE members ADD COLUMN web_id TEXT',
    'ALTER TABLE members ADD COLUMN signing_public_key_hex TEXT',
  ]) {
    db.run(stmt, (e) => { if (e && !String(e.message).includes('duplicate')) console.warn(stmt, e.message); });
  }
  // Persistent registry of device signing keys. The in-memory
  // podKeyRegistry caches lookups, but a listener restart loses it;
  // this table survives restarts so cooperative submissions keep
  // validating after a crash.
  db.run(`
    CREATE TABLE IF NOT EXISTS pod_signing_keys (
      session_id TEXT PRIMARY KEY,
      web_id TEXT,
      public_key_hex TEXT NOT NULL,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME
    )
  `, (e) => { if (e) console.warn('pod_signing_keys init:', e.message); });
  db.run(`
    CREATE TABLE IF NOT EXISTS replay_cache (
      signature TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seen_at_ms INTEGER NOT NULL
    )
  `, (e) => { if (e) console.warn('replay_cache init:', e.message); });
  const aiSchema = path.join(DESKTOP, 'forum-ai', 'database_syncs', 'init_schema.sql');
  if (fs.existsSync(aiSchema)) {
    const aiDb = path.join(DESKTOP, 'forum-ai', 'database_syncs', 'forum_inbound.db');
    const aiConn = new sqlite3.Database(aiDb);
    aiConn.exec(fs.readFileSync(aiSchema, 'utf8'), (e) => {
      if (e) console.error('forum-ai schema init failed:', e.message);
      else console.log('forum-ai inbound schema ready.');
      aiConn.close();
    });
  }
}

function persistSigningKey(sessionId, webId, publicKeyHex) {
  if (!sessionId || !publicKeyHex) return;
  db.run(
    `INSERT INTO pod_signing_keys (session_id, web_id, public_key_hex, registered_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(session_id) DO UPDATE SET
       web_id = excluded.web_id,
       public_key_hex = excluded.public_key_hex,
       last_used_at = CURRENT_TIMESTAMP`,
    [sessionId, webId || null, publicKeyHex],
    (e) => { if (e) console.warn('pod_signing_keys upsert:', e.message); }
  );
}

function loadSigningKey(sessionId) {
  return new Promise((resolve) => {
    if (!sessionId) return resolve(null);
    db.get(
      `SELECT public_key_hex FROM pod_signing_keys WHERE session_id = ?`,
      [sessionId],
      (err, row) => {
        if (err) {
          console.warn('pod_signing_keys lookup:', err.message);
          return resolve(null);
        }
        resolve(row ? row.public_key_hex : null);
      }
    );
  });
}

/**
 * sha256 hex of the device's Ed25519 public key. Used as a stable
 * non-PII member identifier on cooperative ledger rows now that we no
 * longer gate on a zkEmail-derived email_hash. Schema columns still
 * named `email_hash` are populated with this value so existing NOT NULL
 * constraints stay satisfied; nothing in this hash maps back to an
 * email address.
 */
function deviceMemberHash(publicKeyHex) {
  if (!publicKeyHex || typeof publicKeyHex !== 'string') return null;
  return crypto.createHash('sha256').update(publicKeyHex, 'utf8').digest('hex');
}

initSchema();

const listenerReplayStore = {
  checkAndRecord(signature, sessionId) {
    return new Promise((resolve) => {
      if (!signature) return resolve(false);
      const nowMs = Date.now();
      const cutoffMs = nowMs - 6 * 60 * 1000;
      db.run(`DELETE FROM replay_cache WHERE seen_at_ms < ?`, [cutoffMs], () => {
        db.run(
          `INSERT OR IGNORE INTO replay_cache (signature, session_id, seen_at_ms) VALUES (?, ?, ?)`,
          [signature, sessionId || '', nowMs],
          function onInsert() {
            resolve(this.changes === 0);
          }
        );
      });
    });
  },
};

const verifyAirlock = (req, res, next) => {
  const secret = req.headers['x-airlock-secret'];
  if (!secret || secret !== process.env.AIRLOCK_SECRET) {
    console.warn(`Unauthorized: ${req.method} ${req.path} from ${req.ip}`);
    return res.status(403).json({ message: 'Invalid Airlock Secret' });
  }
  next();
};

function runVault(encryptedData) {
  return new Promise((resolve) => {
    const child = spawn('python3', [vaultPath, encryptedData], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

function maybeRunAnalysis() {
  if (process.env.FORUM_AUTO_ANALYSIS !== '1') return;
  spawn('bash', [analysisScript], {
    env: { ...process.env },
    detached: true,
    stdio: 'ignore',
  }).unref();
}

function checkExportRate(webId) {
  const key = webId || 'anonymous';
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxPerWindow = 30;
  let bucket = exportRateByWebId.get(key) || [];
  bucket = bucket.filter((t) => now - t < windowMs);
  if (bucket.length >= maxPerWindow) return false;
  bucket.push(now);
  exportRateByWebId.set(key, bucket);
  return true;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'forum-airlock-listener' });
});

app.post('/register-member', verifyAirlock, (req, res) => {
  handleRegisterMember(req, res);
});

app.post('/api/register-member', (req, res) => {
  handleRegisterMember(req, res);
});

function handleRegisterMember(req, res) {
  const { credential_id, public_key, web_id, public_key_hex, session_id } = req.body;
  if (!credential_id || !public_key) {
    return res.status(400).json({ error: 'Missing WebAuthn parameters' });
  }
  const stmt = db.prepare(
    'INSERT INTO members (credential_id_hash, public_key_pem, web_id, signing_public_key_hex) VALUES (?, ?, ?, ?)'
  );
  stmt.run(
    [credential_id, public_key, web_id || null, public_key_hex || null],
    function onRun(err) {
      if (err) {
        if (String(err.message).includes('UNIQUE')) {
          return res.status(409).json({ error: 'Credential already registered', member_id: null });
        }
        console.error('Registration Ledger Error:', err.message);
        return res.status(500).json({ error: 'Failed to record public key' });
      }
      const memberId = this.lastID;
      if (session_id && public_key_hex) {
        registerPodKey(podKeyRegistry, session_id, public_key_hex);
        persistSigningKey(session_id, web_id || null, public_key_hex);
      }
      if (web_id && public_key_hex) {
        registerPodKey(podKeyRegistry, web_id, public_key_hex);
        persistSigningKey(web_id, web_id, public_key_hex);
      }
      console.log(`New WebAuthn Member Registered. DB ID: ${memberId}`);
      res.json({ success: true, member_id: memberId });
    }
  );
  stmt.finalize();
}

app.post('/api/register-signing-key', (req, res) => {
  const { session_id, web_id, public_key_hex } = req.body;
  if (!public_key_hex || (!session_id && !web_id)) {
    return res.status(400).json({ error: 'session_id or web_id and public_key_hex required' });
  }
  const sid = session_id || web_id;
  registerPodKey(podKeyRegistry, sid, public_key_hex);
  persistSigningKey(sid, web_id || null, public_key_hex);
  if (web_id && session_id && web_id !== session_id) {
    registerPodKey(podKeyRegistry, web_id, public_key_hex);
    persistSigningKey(web_id, web_id, public_key_hex);
  }
  res.json({ success: true });
});

async function handleCivicSubmit(req, res) {
  const { receiptId, encryptedData, memberId } = req.body;
  if (!encryptedData || !receiptId) {
    return res.status(400).json({ message: 'Missing payload or receipt' });
  }

  const stmt = db.prepare(
    'INSERT INTO civic_payloads (receipt_id, encrypted_payload, verified_member_id) VALUES (?, ?, ?)'
  );
  stmt.run([receiptId, encryptedData, memberId || null], async function onRun(err) {
    if (err) {
      console.error('Payload Ledger Error:', err.message);
      return res.status(500).json({ message: 'Failed to record payload receipt' });
    }

    console.log(`Payload securely ledgered. Receipt: ${receiptId}`);
    const vault = await runVault(encryptedData);
    if (vault.code !== 0) {
      console.error(`Vault Error: ${vault.err || vault.out}`);
    } else {
      console.log(`Vault Processed: ${vault.out}`);
      maybeRunAnalysis();
    }

    res.json({
      message: 'Payload secured and receipt generated',
      receiptId,
      vault: vault.code === 0 ? 'ok' : 'error',
    });
  });
  stmt.finalize();
}

/**
 * Insert a synthetic members_email_proof row for the device member
 * hash so any FK that still references that table is satisfied. The
 * row is *not* an email proof — it's a placeholder keyed on the device
 * public key hash. Idempotent.
 */
function ensureMemberHashRow(memberHash) {
  return new Promise((resolve) => {
    if (!/^[0-9a-f]{64}$/.test(String(memberHash || ''))) return resolve();
    const aiConn = new sqlite3.Database(AI_DB_PATH);
    aiConn.run(
      `INSERT INTO members_email_proof
         (email_hash, domain_hash, proof_kind, proof_receipt, joined_at, last_seen_at)
       VALUES (?, NULL, 'device-pubkey-hash-v1', NULL,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(email_hash) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP`,
      [memberHash],
      (err) => {
        aiConn.close();
        if (err) console.warn('ensureMemberHashRow:', err.message);
        resolve();
      }
    );
  });
}

// Master taxonomy. Must mirror forum-pod/src/insight-categories.js.
// Used to validate inbound feedback rows and reject malformed kinds.
const FORUM_FEEDBACK_TAXONOMY = {
  // behavioral
  purchasing: { kind: 'behavioral',    label: 'Bought something' },
  media:      { kind: 'behavioral',    label: 'Watched / read / listened' },
  civic:      { kind: 'behavioral',    label: 'Civic action' },
  social:     { kind: 'behavioral',    label: 'Community / social' },
  health:     { kind: 'behavioral',    label: 'Health / body' },
  // psychographic
  value:      { kind: 'psychographic', label: 'Value or belief' },
  interest:   { kind: 'psychographic', label: 'Interest / hobby' },
  lifestyle:  { kind: 'psychographic', label: 'Lifestyle' },
  attitude:   { kind: 'psychographic', label: 'Opinion / attitude' },
  // legacy passthrough — civic Maslow tiers (1..4) collapse here
  'civic-legacy': { kind: 'civic', label: 'Civic (legacy)' },
};

function normaliseFeedback(payload) {
  // Accept both the new shape (category_code) and the legacy civic
  // shape (category_id + category_label). Return a canonical record
  // ready to insert into forum_feedback / forum_exports.
  let categoryCode = payload.category_code || payload.categoryCode;
  let categoryLabel = payload.category_label || payload.categoryLabel;
  let kind = payload.kind;

  if (!categoryCode && payload.category_id != null) {
    // Legacy civic submission. Collapse all four tiers into 'civic-legacy'
    // so analysts can tell them apart from v1.5+ rows. The label keeps
    // the granular Maslow tier name.
    categoryCode = 'civic-legacy';
    kind = 'civic';
    categoryLabel = categoryLabel || `Civic tier ${payload.category_id}`;
  }

  const taxon = FORUM_FEEDBACK_TAXONOMY[categoryCode];
  if (!taxon) {
    return { error: `unknown category_code: ${categoryCode}` };
  }
  return {
    receipt_id:     payload.receipt_id,
    kind:           kind || taxon.kind,
    category_code:  categoryCode,
    category_label: categoryLabel || taxon.label,
    zip_code:       payload.zip_code || null,
    comment:        payload.comment || '',
  };
}

async function handleForumFeedback(req, res) {
  const outer = req.body;
  // Two-tier signing-key lookup: in-memory podKeyRegistry first, then
  // pod_signing_keys SQLite table. The DB fallback means a listener
  // restart no longer 401s every signed submission until the device
  // re-calls /api/register-signing-key.
  const sigResult = await verifyBundle(
    outer,
    async (sessionId) => {
      const cached = podKeyRegistry.get(sessionId);
      if (cached) return cached;
      const persisted = await loadSigningKey(sessionId);
      if (persisted) registerPodKey(podKeyRegistry, sessionId, persisted);
      return persisted || null;
    },
    listenerReplayStore
  );
  if (!sigResult.valid) {
    return res.status(401).json({
      message: `Payload authentication failed: ${sigResult.reason}`,
    });
  }

  const payload = outer.payload;
  if (!payload || !payload.consent) {
    return res.status(400).json({ message: 'consent required for cooperative export' });
  }

  const norm = normaliseFeedback(payload);
  if (norm.error) {
    return res.status(400).json({ message: norm.error });
  }
  if (!norm.receipt_id || !norm.comment) {
    return res.status(400).json({ message: 'receipt_id and comment are required' });
  }

  const webId = payload.webId || outer.sessionId;
  if (!checkExportRate(webId)) {
    return res.status(429).json({ message: 'Rate limit exceeded for this WebID' });
  }

  // Device-derived member identifier. Schema columns are still named
  // `email_hash` (NOT NULL FK) so we feed them this stable
  // non-PII hash. Nothing here maps back to an email address.
  const memberHash = deviceMemberHash(outer.publicKeyHex);
  if (!memberHash) {
    return res.status(400).json({ message: 'missing public_key_hex on signed bundle' });
  }
  await ensureMemberHashRow(memberHash);

  const encryptedData = Buffer.from(JSON.stringify(payload)).toString('base64');
  const consentAt = payload.consent_at || new Date().toISOString();
  const policyVersion = payload.policy_version || 'coop-data-policy/2026-05-01';

  // 1) Local airlock ledger row (forum_payloads + forum_exports).
  db.run(
    `INSERT INTO forum_payloads (receipt_id, kind, category_code, encrypted_payload)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(receipt_id) DO UPDATE SET encrypted_payload = excluded.encrypted_payload`,
    [norm.receipt_id, norm.kind, norm.category_code, encryptedData],
    (payloadErr) => {
      if (payloadErr) console.warn('forum_payloads write error:', payloadErr.message);
    }
  );

  db.run(
    `INSERT INTO forum_exports
       (receipt_id, kind, category_code, web_id, email_hash, consent_at, policy_version, session_id, public_key_hex)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      norm.receipt_id, norm.kind, norm.category_code, webId, memberHash,
      consentAt, policyVersion, outer.sessionId, outer.publicKeyHex,
    ],
    async function onExport(err) {
      if (err) {
        console.error('forum_exports ledger error:', err.message);
        return res.status(500).json({ message: 'Failed to record export' });
      }

      const vault = await runVault(encryptedData);

      // 2) Cooperative-side row in forum_inbound.db -> forum_feedback.
      const aiConn = new sqlite3.Database(AI_DB_PATH);
      aiConn.run(
        `INSERT INTO forum_feedback
           (receipt_id, kind, category_code, category_label, zip_code, comment,
            email_hash, domain_hash, web_id, session_id, public_key_hex,
            signature_hex, consent_at, policy_version, encrypted_blob)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(receipt_id) DO UPDATE SET
           kind           = excluded.kind,
           category_code  = excluded.category_code,
           category_label = excluded.category_label,
           zip_code       = excluded.zip_code,
           comment        = excluded.comment,
           consent_at     = excluded.consent_at,
           policy_version = excluded.policy_version,
           encrypted_blob = excluded.encrypted_blob`,
        [
          norm.receipt_id, norm.kind, norm.category_code, norm.category_label,
          norm.zip_code, norm.comment, memberHash, null, webId,
          outer.sessionId, outer.publicKeyHex, outer.signature || null,
          consentAt, policyVersion, encryptedData,
        ],
        (insertErr) => {
          aiConn.close();
          if (insertErr) console.warn('forum_feedback insert error:', insertErr.message);
        }
      );

      if (vault.code === 0) maybeRunAnalysis();
      res.json({
        message: 'Forum Feedback accepted',
        receiptId: norm.receipt_id,
        kind: norm.kind,
        category_code: norm.category_code,
        vault: vault.code === 0 ? 'ok' : 'error',
      });
    }
  );
}

// Canonical route.
app.post('/api/forum/feedback', handleForumFeedback);

// Legacy alias kept so pre-v1.5 Pods continue to work. New code should
// use /api/forum/feedback. Remove once telemetry confirms no callers.
app.post('/api/civic/export', (req, res) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', '</api/forum/feedback>; rel="successor-version"');
  return handleForumFeedback(req, res);
});

app.post('/submit', verifyAirlock, handleCivicSubmit);
app.post('/api/civic/submit', verifyAirlock, handleCivicSubmit);
app.post('/api/forum/receipt', verifyAirlock, handleCivicSubmit);

const PORT = Number(process.env.LISTENER_PORT || 3000);
const server = app.listen(PORT, () => {
  console.log(`Sovereign Listener active on port ${PORT}`);
  if (!process.env.AIRLOCK_SECRET) {
    console.warn('WARNING: AIRLOCK_SECRET is not set. Copy forum.config.env.example → forum.config.env');
  } else {
    console.log(`AIRLOCK_SECRET loaded (${process.env.AIRLOCK_SECRET.length} chars)`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Airlock listener already appears to be running on port ${PORT}.`);
    console.log('Use the existing process, or stop it before starting another listener.');
    process.exit(0);
  }
  console.error('Listener failed:', err);
  process.exit(1);
});

server.ref();

function shutdown(signal) {
  console.log(`${signal} received, shutting down Forum Airlock Listener...`);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
