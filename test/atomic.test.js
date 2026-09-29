import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { replaceWithRetry } from '../src/atomic.js';
import { atomicWrite } from '../src/sync.js';

test('a transient sharing violation is retried before the replacement fails', async () => {
  const waits = [];
  let calls = 0;
  const rename = async () => { if (++calls < 3) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); };
  await replaceWithRetry('temp', 'target', { rename, sleep: ms => { waits.push(ms); return Promise.resolve(); } });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [50, 100]);
});

test('permanent failures are not retried and a persistent conflict eventually gives up', async () => {
  let calls = 0;
  const rename = code => async () => { calls++; throw Object.assign(new Error(code), { code }); };
  await assert.rejects(replaceWithRetry('temp', 'target', { rename: rename('ENOENT'), sleep: async () => {} }), { code: 'ENOENT' });
  assert.equal(calls, 1, 'A missing directory or file is reported at once');
  calls = 0;
  await assert.rejects(replaceWithRetry('temp', 'target', { rename: rename('EPERM'), sleep: async () => {} }), { code: 'EPERM' });
  assert.equal(calls, 6, 'One attempt plus five retries');
});

test('a reader holding the file open does not fail the write', async t => {
  // On Windows a second handle blocks the replacement (EPERM) even when it was opened by this very
  // process, which is the normal situation for status.json: the control panel reads it every 500 ms
  // while the service rewrites it. The write has to outlast that window instead of failing.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-atomic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'status.json');
  await fs.writeFile(file, 'old');
  const held = await fs.open(file, 'r');
  const release = setTimeout(() => held.close(), 120);
  try {
    await atomicWrite(file, 'new');
    assert.equal(await fs.readFile(file, 'utf8'), 'new');
  } finally { clearTimeout(release); await held.close().catch(() => {}); }
});
