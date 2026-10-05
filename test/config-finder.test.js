import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { searchConfig, finderPermissions, validateFoundConfig } from '../src/config-finder.js';
import { isolatedConfig } from '../src/runtime.js';

test('finder accepts only executed glob evidence, validates files, and cleans its session', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-finder-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const base = path.join(root, '.workbuddy');
  await fs.mkdir(base);
  const file = path.join(base, 'models.json');
  await fs.writeFile(file, '\uFEFF{"models":[]}');
  const calls = [];
  const backend = { async request(route, method, body) {
    calls.push({ route, method, body });
    if (route === '/permission') return [];
    if (route === '/session') return { id: 'finder' };
    if (method === 'GET') return [{ parts: [
      { type: 'text', text: '/invented/models.json' },
      { type: 'tool', tool: 'read', state: { status: 'completed', output: '/secret/models.json' } },
      { type: 'tool', tool: 'glob', state: { status: 'completed', input: { path: base }, output: 'models.json\nmissing/models.json\n' } },
    ] }];
    return {};
  } };
  const result = await searchConfig(backend, [{ id: 'opencode/test', toolcall: true }], [root]);
  assert.deepEqual(result.candidates, [file]);
  assert.equal(finderPermissions['*'], 'ask');
  assert.deepEqual(Object.keys(finderPermissions).filter(k => finderPermissions[k] === 'allow'), ['glob', 'list', 'external_directory']);
  assert.deepEqual(isolatedConfig.agent['buddy-config-finder'].permission, finderPermissions);
  assert.equal(isolatedConfig.agent['buddy-bridge'].permission['*'], 'ask');
  assert.deepEqual(calls[0].body.permission, Object.entries(finderPermissions).map(([permission, action]) => ({ permission, pattern: '*', action })));
  assert.equal(calls.find(c => c.route.endsWith('/message') && c.method === 'POST').body.agent, 'buddy-config-finder');
  assert.equal(calls.at(-1).method, 'DELETE');
  assert.equal(await fs.readFile(file, 'utf8'), '\uFEFF{"models":[]}');
});

test('finder falls back after model failure and never accepts text-only invented paths', async () => {
  let count = 0, deleted = 0;
  const backend = { async request(route, method) {
    if (route === '/permission') return [];
    if (route === '/session') return { id: String(++count) };
    if (method === 'DELETE') { deleted++; return {}; }
    if (method === 'POST' && route.endsWith('/message') && count === 1) throw new Error('quota');
    if (method === 'GET') return [{ parts: [{ type: 'text', text: '/some/models.json' }] }];
    return {};
  } };
  const result = await searchConfig(backend, [{ id: 'opencode/one' }, { id: 'opencode/two' }], [path.join(os.tmpdir(), 'ow-missing-test-root')], undefined, () => { throw new Error('Should not validate invented paths'); });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.errors.length, 1);
  assert.equal(deleted, 2);
});

test('finder cancels without continuing to other models and still cleans session', async () => {
  const controller = new AbortController();
  let sessions = 0, deleted = false;
  const backend = { async request(route, method) {
    if (route === '/permission') return [];
    if (route === '/session') { sessions++; return { id: 'cancel' }; }
    if (route.endsWith('/message')) { controller.abort(); throw new Error('canceled'); }
    if (method === 'DELETE') deleted = true;
    return {};
  } };
  await assert.rejects(searchConfig(backend, [{ id: 'opencode/one' }, { id: 'opencode/two' }], [path.join(os.tmpdir(), 'ow-missing-test-root')], controller.signal), /canceled/);
  assert.equal(sessions, 1);
  assert.equal(deleted, true);
});


test('discovered generic models.json is not automatically treated as WorkBuddy', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-finder-other-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'models.json');
  await fs.writeFile(file, '[]');
  await assert.rejects(validateFoundConfig(file), /无法确认/);
  await fs.writeFile(file, JSON.stringify([{ id: 'custom', vendor: 'Custom', url: 'http://localhost/v1', apiKey: 'fixture' }]));
  assert.equal(await validateFoundConfig(file), file);
});

test('provider errors in successful HTTP envelopes are reported as failures', async () => {
  const backend = { async request(route) {
    if (route === '/permission') return [];
    return route === '/session' ? { id: 'error' } : { info: { error: { data: { message: 'quota exhausted' } } } };
  } };
  const result = await searchConfig(backend, [{ id: 'opencode/test' }], [path.join(os.tmpdir(), 'ow-missing-test-root')]);
  assert.deepEqual(result.candidates, []);
  assert.match(result.errors[0], /quota exhausted/);
});


test('finder rejects native approvals only for its own session', async () => {
  const replies = [];
  let finish;
  const backend = { async request(route, method, body) {
    if (route === '/session') return { id: 'finder' };
    if (route === '/permission') return [
      { id: 'read-secret', sessionID: 'finder' }, { id: 'execute', sessionID: 'finder' }, { id: 'other', sessionID: 'unrelated' },
    ];
    if (route.startsWith('/permission/')) { replies.push({route,body}); if(replies.length === 2) finish({}); return {}; }
    if (route.endsWith('/message') && method === 'POST') return new Promise(resolve => { finish = resolve; });
    if (method === 'GET') return [];
    return {};
  } };
  await searchConfig(backend, [{ id: 'opencode/test' }], [path.join(os.tmpdir(), 'ow-missing-test-root')]);
  assert.equal(replies.length, 2);
  assert.ok(replies.every(r => r.body.reply === 'reject'));
  assert.ok(!replies.some(r => r.route.includes('other')));
});

test('hidden WorkBuddy config is retained when OpenCode glob returns only visible config', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-hidden-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const hidden = path.join(root, '中文 空格', '.workbuddy', 'models.json');
  const visible = path.join(root, 'WorkBuddy', 'models.json');
  for (const file of [hidden, visible]) {
    await fs.mkdir(path.dirname(file), {recursive:true});
    await fs.writeFile(file,'[]');
  }
  const backend = {async request(route, method) {
    if (route === '/permission') return [];
    if (route === '/session') return {id:'hidden'};
    if (method === 'GET') return [{parts:[{type:'tool',tool:'glob',state:{status:'completed',input:{path:root},output:visible}}]}];
    return {};
  }};
  const result = await searchConfig(backend,[{id:'opencode/test'}],[root]);
  assert.deepEqual(new Set(result.candidates), new Set([hidden,visible]));
  assert.equal(await fs.readFile(hidden,'utf8'),'[]');
});
