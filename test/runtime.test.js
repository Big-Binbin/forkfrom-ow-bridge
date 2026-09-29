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
// A synthetic runtime is a POSIX shell script. Windows cannot execute that (no shebang support and no
// shell), so there the version is probed from the fixture's own content while discovery, copying,
// extraction and version verification stay real on both platforms.
const synthetic = process.platform === 'win32'
  ? { probe: async file => (await fs.readFile(file, 'utf8')).trim(), content: version => version }
  : { probe: undefined, content: version => `#!/bin/sh\nprintf '%s\\n' '${version}'\n` };
async function binary(file, version) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, synthetic.content(version), { mode: 0o755 });
}

test('reuse local runtimes when official latest cannot be checked', async t => {
  const root = await fixture(t);
  const pkg = runtimePackage();
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Should not contact npm'); });
  const old = path.join(root, 'managed', 'runtime', '1.18.32', pkg.binary);
  await binary(old, '1.18.32');
  assert.equal(await findRuntime(path.join(root, 'managed'), () => {}, { probe: synthetic.probe, candidates: [] }), old);
  const newer = path.join(root, 'source', pkg.binary);
  await binary(newer, '1.25.7');
  const copied = await findRuntime(path.join(root, 'fresh'), () => {}, { probe: synthetic.probe, candidates: [newer] });
  assert.equal(copied, path.join(root, 'fresh', 'runtime', '1.25.7', pkg.binary));
  assert.equal(await fs.readFile(copied, 'utf8'), await fs.readFile(newer, 'utf8'));
  const log = [];
  assert.equal(await findRuntime(path.join(root, 'fresh'), () => {}, { probe: synthetic.probe, candidates: [newer], log: m => log.push(m) }), copied);
  assert.match(log.join('\n'), /using local/i, 'Reusing an already prepared runtime is reported');
});


test('reuse local runtime only when it is not older than official latest', async t => {
  const root = await fixture(t);
  const pkg = runtimePackage();
  const current = path.join(root, 'source', pkg.binary);
  await binary(current, '1.25.7');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async target => {
    calls.push(target);
    return Response.json({ name: pkg.name, version: '1.25.7',
      dist: { integrity: 'sha512-placeholder', tarball: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-1.25.7.tgz` } });
  });
  const copied = await findRuntime(path.join(root, 'managed'), () => {}, { probe: synthetic.probe, candidates: [current] });
  assert.equal(copied, path.join(root, 'managed', 'runtime', '1.25.7', pkg.binary));
  assert.deepEqual(calls, [`https://registry.npmjs.org/${pkg.name}/latest`]);
});

test('download official latest when a local runtime is stale', async t => {
  const root = await fixture(t);
  const pkg = runtimePackage();
  const stale = path.join(root, 'source', pkg.binary);
  await binary(stale, '1.17.8');
  await binary(path.join(root, 'package', 'bin', pkg.binary), '1.18.33');
  const archive = path.join(root, 'source.tgz');
  await tar({ cwd: root, file: archive, gzip: true }, [`package/bin/${pkg.binary}`]);
  const bytes = await fs.readFile(archive);
  const url = `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-1.18.33.tgz`;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async target => {
    calls.push(target);
    if (target.endsWith('/latest')) return Response.json({ name: pkg.name, version: '1.18.33',
      dist: { integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, tarball: url } });
    assert.equal(target, url);
    return new Response(bytes);
  });
  const file = await findRuntime(path.join(root, 'install'), () => {}, { probe: synthetic.probe, candidates: [stale] });
  assert.equal(file, path.join(root, 'install', 'runtime', '1.18.33', pkg.binary));
  assert.deepEqual(calls, [`https://registry.npmjs.org/${pkg.name}/latest`, url]);
});

test('candidates that cannot serve as the runtime are reported instead of silently ignored', async t => {
  const root = await fixture(t);
  const pkg = runtimePackage();
  const shim = path.join(root, 'source', 'opencode.cmd');
  await binary(shim, '1.25.7');
  await binary(path.join(root, 'source', 'broken', pkg.binary), 'not-a-version');
  const log = [];
  t.mock.method(globalThis, 'fetch', () => Response.json({ name: pkg.name, version: '1.25.7', dist: {} }));
  await assert.rejects(findRuntime(root, () => {}, { probe: synthetic.probe, candidates: [shim, path.join(root, 'source', 'broken', pkg.binary)], log: m => log.push(m) }), /Unexpected official/);
  assert.match(log.join('\n'), /launcher script/);
  assert.match(log.join('\n'), /unrecognized version output/, 'A candidate whose version cannot be read is explained');
});

test('first install resolves official latest and checks the downloaded executable version', async t => {
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
  const file = await findRuntime(path.join(root, 'install'), () => {}, { probe: synthetic.probe, candidates: [] });
  assert.equal(file, path.join(root, 'install', 'runtime', '1.25.7', pkg.binary));
  assert.deepEqual(calls, [`https://registry.npmjs.org/${pkg.name}/latest`, url]);
  reportedVersion = '1.25.8';
  await assert.rejects(findRuntime(path.join(root, 'mismatch'), () => {}, { probe: synthetic.probe, candidates: [] }), /version mismatch/);
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
