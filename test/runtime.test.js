import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { c as tar } from 'tar';
import { findRuntime } from '../src/runtime.js';
import { runtimePackage } from '../src/platform.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function binary(file, version) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
}
const shellFixture = { skip: process.platform === 'win32' ? 'Synthetic executable uses a POSIX shell' : false };

test('reuse managed and installed versions without contacting npm or requiring a pinned version', shellFixture, async t => {
  const root = await fixture(t);
  const pkg = runtimePackage();
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Should not contact npm'); });
  const old = path.join(root, 'managed', 'runtime', '1.18.32', pkg.binary);
  await binary(old, '1.18.32');
  assert.equal(await findRuntime(path.join(root, 'managed'), () => {}, { candidates: [] }), old);
  const newer = path.join(root, 'source', pkg.binary);
  await binary(newer, '1.25.7');
  const copied = await findRuntime(path.join(root, 'fresh'), () => {}, { candidates: [newer] });
  assert.equal(copied, path.join(root, 'fresh', 'runtime', '1.25.7', pkg.binary));
  assert.equal(await fs.readFile(copied, 'utf8'), await fs.readFile(newer, 'utf8'));
});

test('first install resolves official latest and checks the downloaded executable version', shellFixture, async t => {
  const root = await fixture(t);
  const pkg = runtimePackage();
  await binary(path.join(root, 'package', 'bin', pkg.binary), '1.25.7');
  const archive = path.join(root, 'source.tgz');
  await tar({ cwd: root, file: archive, gzip: true }, [`package/bin/${pkg.binary}`]);
  const bytes = await fs.readFile(archive);
  const url = `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-1.25.7.tgz`;
  const calls = [];
  let reportedVersion = '1.25.7';
  t.mock.method(globalThis, 'fetch', async target => {
    calls.push(target);
    if (target.endsWith('/latest')) return Response.json({ name: pkg.name, version: reportedVersion,
      dist: { integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, tarball: url } });
    assert.equal(target, url);
    return new Response(bytes);
  });
  const file = await findRuntime(path.join(root, 'install'), () => {}, { candidates: [] });
  assert.equal(file, path.join(root, 'install', 'runtime', '1.25.7', pkg.binary));
  assert.deepEqual(calls, [`https://registry.npmjs.org/${pkg.name}/latest`, url]);
  reportedVersion = '1.25.8';
  await assert.rejects(findRuntime(path.join(root, 'mismatch'), () => {}, { candidates: [] }), /version mismatch/);
});

test('latest installation rejects unofficial metadata and a checksum mismatch', async t => {
  const root = await fixture(t);
  const pkg = runtimePackage();
  let external = true;
  t.mock.method(globalThis, 'fetch', async target => target.endsWith('/latest')
    ? Response.json({ name: pkg.name, version: '1.25.7', dist: { integrity: 'sha512-invalid',
      tarball: external ? 'https://example.com/runtime.tgz' : `https://registry.npmjs.org/${pkg.name}/-/test.tgz` } })
    : new Response('wrong bytes'));
  await assert.rejects(findRuntime(root, () => {}, { candidates: [] }), /Unexpected official/);
  external = false;
  await assert.rejects(findRuntime(root, () => {}, { candidates: [] }), /checksum mismatch/);
  await assert.rejects(fs.access(path.join(root, 'runtime', '1.25.7', pkg.binary)));
});
