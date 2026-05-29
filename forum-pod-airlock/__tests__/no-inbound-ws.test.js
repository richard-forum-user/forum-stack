import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = join(__dir, '..');

function jsFiles() {
  return readdirSync(root).filter((f) => f.endsWith('.js') && f !== 'workerd.capnp');
}

test('no inbound WebSocket server accept in pod worker modules', () => {
  const forbidden = [/new\s+WebSocketPair\s*\(/, /\.accept\s*\(\s*\)/];
  const allowedClientAccept = /ws\.accept\s*\(\s*\)/;
  for (const file of jsFiles()) {
    const src = readFileSync(join(root, file), 'utf8');
    if (file === 'pod-sync.js') {
      assert.match(src, allowedClientAccept, 'pod-sync should use client ws.accept() only');
      continue;
    }
    for (const pat of forbidden) {
      assert.doesNotMatch(
        src,
        pat,
        `${file} must not create inbound WebSocket listeners (${pat})`
      );
    }
  }
});
