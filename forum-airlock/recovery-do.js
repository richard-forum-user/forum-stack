/**
 * RecoveryDO — one Durable Object per recovery identity.
 * Keyed by recovery_id = sha256(recovery_pub_hex).
 *
 * Holds: recovery public key, linked device signing keys, submission receipt
 * ledger (receipt_id + payload_sha256). No raw content, no email, no phrase.
 */

import { canonicalise } from './recovery-crypto.js';

const REBIND_TTL_MS = 15 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function defaultState() {
  return {
    recovery_pub_hex: null,
    linked_device_keys: [],
    receipts: [],
    created_at: null,
    last_recovered_at: null,
    pending_challenge: null,
    pending_rebind: null,
  };
}

export class RecoveryDO {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
  }

  async loadState() {
    const stored = await this.state.storage.get('record');
    return stored ? { ...defaultState(), ...stored } : defaultState();
  }

  async saveState(record) {
    await this.state.storage.put('record', record);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    let body = {};
    if (request.method === 'POST') {
      try {
        body = await request.json();
      } catch {
        return json({ error: 'invalid_json' }, 400);
      }
    }

    if (path === '/enroll' && request.method === 'POST') {
      return this.handleEnroll(body);
    }
    if (path === '/challenge' && request.method === 'POST') {
      return this.handleChallenge(body);
    }
    if (path === '/recover' && request.method === 'POST') {
      return this.handleRecover(body);
    }
    if (path === '/append-receipt' && request.method === 'POST') {
      return this.handleAppendReceipt(body);
    }
    if (path === '/consume-rebind' && request.method === 'POST') {
      return this.handleConsumeRebind(body);
    }
    if (path === '/status' && request.method === 'GET') {
      const record = await this.loadState();
      return json({
        enrolled: Boolean(record.recovery_pub_hex),
        linked_device_keys: record.linked_device_keys?.length || 0,
        receipts: record.receipts?.length || 0,
        created_at: record.created_at,
        last_recovered_at: record.last_recovered_at,
      });
    }

    return json({ error: 'not_found', path }, 404);
  }

  async handleEnroll(body) {
    const { recovery_pub_hex, device_pubkey_hex } = body || {};
    if (!recovery_pub_hex || !device_pubkey_hex) {
      return json({ error: 'recovery_pub_hex and device_pubkey_hex required' }, 400);
    }

    const record = await this.loadState();
    if (!record.recovery_pub_hex) {
      record.recovery_pub_hex = recovery_pub_hex;
      record.created_at = new Date().toISOString();
    } else if (record.recovery_pub_hex !== recovery_pub_hex) {
      return json({ error: 'recovery_identity_mismatch' }, 409);
    }

    if (!record.linked_device_keys.includes(device_pubkey_hex)) {
      record.linked_device_keys.push(device_pubkey_hex);
    }
    await this.saveState(record);
    return json({
      ok: true,
      recovery_pub_hex: record.recovery_pub_hex,
      linked_device_keys: record.linked_device_keys,
      created_at: record.created_at,
    });
  }

  async handleChallenge(body) {
    const { recovery_pub_hex } = body || {};
    const record = await this.loadState();
    if (!record.recovery_pub_hex) {
      return json({ error: 'not_enrolled' }, 404);
    }
    if (recovery_pub_hex && recovery_pub_hex !== record.recovery_pub_hex) {
      return json({ error: 'recovery_identity_mismatch' }, 409);
    }

    const nonce = crypto.randomUUID();
    record.pending_challenge = {
      nonce,
      expires_at: Date.now() + CHALLENGE_TTL_MS,
    };
    await this.saveState(record);
    return json({
      ok: true,
      nonce,
      recovery_pub_hex: record.recovery_pub_hex,
      expires_in_sec: Math.floor(CHALLENGE_TTL_MS / 1000),
    });
  }

  async handleRecover(body) {
    const { nonce, recovery_pub_hex } = body || {};
    const record = await this.loadState();
    if (!record.recovery_pub_hex) {
      return json({ error: 'not_enrolled' }, 404);
    }
    if (recovery_pub_hex && recovery_pub_hex !== record.recovery_pub_hex) {
      return json({ error: 'recovery_identity_mismatch' }, 409);
    }
    const challenge = record.pending_challenge;
    if (!challenge || challenge.nonce !== nonce) {
      return json({ error: 'invalid_challenge' }, 401);
    }
    if (Date.now() > challenge.expires_at) {
      return json({ error: 'challenge_expired' }, 401);
    }

    record.pending_challenge = null;
    record.last_recovered_at = new Date().toISOString();
    const rebindToken = crypto.randomUUID();
    record.pending_rebind = {
      token: rebindToken,
      expires_at: Date.now() + REBIND_TTL_MS,
    };
    await this.saveState(record);

    return json({
      ok: true,
      recovery_pub_hex: record.recovery_pub_hex,
      linked_device_keys: record.linked_device_keys,
      receipts: record.receipts,
      rebind_token: rebindToken,
      rebind_expires_in_sec: Math.floor(REBIND_TTL_MS / 1000),
      last_recovered_at: record.last_recovered_at,
    });
  }

  async handleAppendReceipt(body) {
    const { receipt_id, payload_sha256, ingested_at, report_id } = body || {};
    if (!receipt_id || !payload_sha256) {
      return json({ error: 'receipt_id and payload_sha256 required' }, 400);
    }
    const record = await this.loadState();
    if (!record.recovery_pub_hex) {
      return json({ error: 'not_enrolled' }, 404);
    }

    const existing = record.receipts.find((r) => r.receipt_id === receipt_id);
    if (existing) {
      existing.payload_sha256 = payload_sha256;
      existing.ingested_at = ingested_at || existing.ingested_at;
      if (report_id) existing.report_id = report_id;
    } else {
      record.receipts.push({
        receipt_id,
        payload_sha256,
        ingested_at: ingested_at || new Date().toISOString(),
        report_id: report_id || null,
      });
    }
    await this.saveState(record);
    return json({ ok: true, receipts: record.receipts.length });
  }

  async handleConsumeRebind(body) {
    const { rebind_token, new_device_pubkey_hex } = body || {};
    const record = await this.loadState();
    const pending = record.pending_rebind;
    if (!pending || pending.token !== rebind_token) {
      return json({ error: 'invalid_rebind_token' }, 401);
    }
    if (Date.now() > pending.expires_at) {
      return json({ error: 'rebind_token_expired' }, 401);
    }
    if (!new_device_pubkey_hex) {
      return json({ error: 'new_device_pubkey_hex required' }, 400);
    }

    record.pending_rebind = null;
    if (!record.linked_device_keys.includes(new_device_pubkey_hex)) {
      record.linked_device_keys.push(new_device_pubkey_hex);
    }
    await this.saveState(record);
    return json({
      ok: true,
      recovery_pub_hex: record.recovery_pub_hex,
      linked_device_keys: record.linked_device_keys,
    });
  }
}

export { canonicalise };
