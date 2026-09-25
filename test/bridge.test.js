import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { prepare, decode, completion, sendSSE } from '../src/protocol.js';
import { mergeModels, syncModels, OWNER } from '../src/sync.js';
import { freeModels, Backend } from '../src/backend.js';
import { createServer } from '../src/server.js';

const models = [{ id: 'opencode/test-free', name: 'Test', context: 1000, output: 500 }];
const tools = [{ type: 'function', function: { name: 'write_file', description: 'Write text', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
const body = { model: models[0].id, messages: [{ role: 'user', content: 'Write a file' }], tools };

test('message history preserves roles and tool result IDs, rejects image loss', () => {
  const messages = [...body.messages, { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'write_file', arguments: '{"path":"a"}' } }] }, { role: 'tool', tool_call_id: 'call_a', content: 'done' }];
  const request = prepare({ ...body, messages }, models);
  assert.equal(JSON.parse(request.text)[2].tool_call_id, 'call_a');
  assert.throws(() => prepare({ ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }, models), /text only/);
});
test('tool calls validated; none, forced and required are enforced', () => {
  const call = JSON.stringify({ content: '', calls: [{ name: 'write_file', arguments: { path: 'x' } }] });
  assert.equal(decode(call, prepare(body, models)).tool_calls[0].function.name, 'write_file');
  assert.throws(() => decode(call, prepare({ ...body, tool_choice: 'none' }, models)), /none/);
  assert.throws(() => decode('{"content":"done","calls":[]}', prepare({ ...body, tool_choice: 'required' }, models)), /required/);
  assert.throws(() => decode(call.replace('write_file', 'bash'), prepare(body, models)), /unlisted/);
  assert.throws(() => decode(call.replace('{"path":"x"}', '{}'), prepare(body, models)), /required argument/);
  assert.throws(() => prepare({ ...body, model: 'opencode/paid' }, models), /available free/);
  assert.throws(() => decode('not JSON', prepare(body, models)), /valid bridge/);
});
test('SSE sends structured calls without leaking envelope and includes usage', () => {
  let output = '';
  const message = decode('{"content":"","calls":[{"name":"write_file","arguments":{"path":"x"}}]}', prepare(body, models));
  sendSSE({ write: s => { output += s; }, end: s => { output += s; } }, completion(body.model, message, { input: 4, output: 2 }), true);
  const events = output.split('\n\n').filter(x => x.startsWith('data: {')).map(x => JSON.parse(x.slice(6)));
  assert.ok(events.some(e => e.choices?.[0]?.delta?.tool_calls));
  assert.ok(!events.some(e => e.choices?.[0]?.delta?.content?.includes('calls')));
  assert.equal(events.at(-1).usage.total_tokens, 6);
  assert.ok(output.endsWith('data: [DONE]\n\n'));
});
test('free discovery uses prices, not names; rejects unknown prices and paid output', () => {
  const model = cost => ({ cost, capabilities: { toolcall: true } });
  assert.deepEqual(freeModels({ all: [{ id: 'opencode', models: {
    'big-pickle': model({ input: 0, output: 0 }),
    'bad-free': model({ input: 0, output: 1 }),
    'unknown-free': model(undefined),
  } }] }).map(m => m.id), ['opencode/big-pickle']);
});
test('sync preserves unowned entries and object metadata, removes owned stale entries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-test-'));
  const file = path.join(root, 'models.json');
  const user = { id: 'personal', apiKey: 'private', url: 'existing' };
  const old = { models: [user, { id: 'opencode/old', buddyBridgeOwner: OWNER }], availableModels: ['personal', 'opencode/old'], other: true };
  await fs.writeFile(file, JSON.stringify(old));
  try {
    const result = await syncModels(file, models, 'http://127.0.0.1:41980/v1/chat/completions', 'local-key');
    assert.equal(result.changed, true);
    assert.deepEqual(JSON.parse(await fs.readFile(result.backup, 'utf8')), old);
    const merged = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(merged.models[0], user); assert.equal(merged.other, true);
    assert.deepEqual(merged.availableModels, ['personal', models[0].id]);
    assert.equal((await syncModels(file, models, 'http://127.0.0.1:41980/v1/chat/completions', 'local-key')).changed, false);
    await assert.rejects(syncModels(file, [], 'x', 'x'), /Empty model/);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), merged);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('manual ID collision remains untouched; malformed config is not reset', () => {
  const custom = { id: models[0].id, apiKey: 'mine' };
  assert.deepEqual(mergeModels([custom], models, 'x', 'y'), [custom]);
  assert.throws(() => mergeModels({ unknown: true }, models, 'x', 'y'), /Unrecognized/);
});

async function listen(server) {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}
test('backend requires native approval and cleans sessions on success and model failure', async () => {
  const events = []; let fail = false;
  const fake = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const data = text ? JSON.parse(text) : null;
    events.push({ method: req.method, url: req.url, data });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/permission') return res.end('[]');
    if (req.url === '/session') return res.end('{"id":"ses_test"}');
    if (req.url.endsWith('/message')) return res.end(JSON.stringify(fail ? { info: { error: { data: { message: 'FreeTierError', statusCode: 403 } } } } : { info: { finish: 'stop' }, parts: [{ type: 'text', text: '{"content":"OK","calls":[]}' }] }));
    res.end('true');
  });
  const backend = new Backend(await listen(fake), 'test');
  try {
    await backend.complete(prepare(body, models));
    assert.equal(events.find(e => e.url.endsWith('/message')).data.agent, 'buddy-bridge');
    assert.equal(events.find(e => e.url.endsWith('/message')).data.tools, undefined);
    assert.deepEqual(events.find(e => e.url === '/session').data.permission[0], { permission: '*', pattern: '*', action: 'ask' });
    assert.equal(events.at(-1).method, 'DELETE');
    fail = true;
    await assert.rejects(backend.complete(prepare(body, models)), /FreeTierError/);
    assert.equal(events.at(-2).url, '/session/ses_test/abort'); assert.equal(events.at(-1).method, 'DELETE');
  } finally { fake.closeAllConnections(); fake.close(); }
});
test('HTTP authenticates local clients, rejects origins, supports SSE and model selection', async () => {
  let selected;
  const server = createServer({ key: 'test', backend: { complete: async r => { selected = r.model.id; return completion(r.model.id, { role: 'assistant', content: 'OK' }); } }, getModels: () => models, refresh: async () => ({}), status: () => ({ phase: 'ready' }) });
  const base = await listen(server);
  const headers = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/v1/models')).status, 401);
    assert.equal((await fetch(base + '/v1/models', { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
    assert.equal((await (await fetch(base + '/v1/models', { headers })).json()).data[0].id, models[0].id);
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify({ ...body, stream: true }) });
    assert.ok((await response.text()).includes('[DONE]')); assert.equal(selected, body.model);
  } finally { server.closeAllConnections(); server.close(); }
});

test('native approval requests abort inference without approving any action', async () => {
  const events = []; let started = false;
  const fake = http.createServer(async (req, res) => {
    events.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/session') return res.end('{"id":"ses_blocked"}');
    if (req.url === '/permission') return res.end(JSON.stringify(started ? [{ id: 'per_blocked', sessionID: 'ses_blocked' }] : []));
    if (req.url.endsWith('/message')) { started = true; return; }
    res.end('true');
  });
  const backend = new Backend(await listen(fake), 'test', 1500);
  try {
    await assert.rejects(backend.complete(prepare(body, models)), e => e.code === 'native_tool_activity');
    assert.ok(events.includes('POST /session/ses_blocked/abort'));
    assert.ok(events.includes('DELETE /session/ses_blocked'));
    assert.ok(!events.some(e => e.includes('/reply')));
  } finally { fake.closeAllConnections(); fake.close(); }
});

test('a native action is rejected before a corrected structured response is accepted', async () => {
  let waiting, reply;
  const fake = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/session') return res.end('{"id":"ses_correct"}');
    if (req.url === '/permission') return res.end(JSON.stringify(waiting ? [{ id: 'per_correct', sessionID: 'ses_correct', tool: { callID: 'native_call' } }] : []));
    if (req.url.endsWith('/message')) { waiting = res; return; }
    if (req.url.endsWith('/reply')) {
      reply = JSON.parse(raw);
      waiting.end(JSON.stringify({ info: { structured: { content: 'OK', calls: [] } }, parts: [{ type: 'tool', tool: 'write', callID: 'native_call', state: { status: 'error' } }, { type: 'tool', tool: 'StructuredOutput' }] }));
      waiting = null;
    }
    res.end('true');
  });
  const backend = new Backend(await listen(fake), 'test', 2000);
  try {
    const result = await backend.complete(prepare(body, models));
    assert.equal(reply.reply, 'reject');
    assert.equal(result.choices[0].message.content, 'OK');
  } finally { fake.closeAllConnections(); fake.close(); }
});

test('quota, throttling, access and unknown errors remain distinct', async () => {
  const { modelResult } = await import('../src/model-status.js');
  assert.equal(modelResult(false, 'insufficient_quota', 429).category, 'quota');
  assert.equal(modelResult(false, 'Too many requests', 429).category, 'rate_limit');
  assert.equal(modelResult(false, 'Free tier only within OpenCode', 403).category, 'access');
  assert.equal(modelResult(false, 'Model probe timed out').category, 'timeout');
  assert.equal(modelResult(false, 'Missing file_path', 502).category, 'error');
  assert.equal(modelResult(true).category, 'available');
  const catalog = freeModels({ all: [{ id: 'opencode', models: { exhausted: { cost: { input: 0, output: 0 }, capabilities: { toolcall: true }, remaining: 0 } } }] });
  assert.equal(catalog.length, 1, 'An exhausted free model stays in the catalog');
});

test('withdrawing every managed model preserves user models and metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-withdraw-'));
  const file = path.join(root, 'models.json');
  const old = { models: [{ id: 'personal' }, { id: models[0].id, buddyBridgeOwner: OWNER }], availableModels: ['personal', models[0].id], keep: true };
  await fs.writeFile(file, JSON.stringify(old));
  try {
    await syncModels(file, [], 'local', 'key', { allowEmpty: true });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { models: [{ id: 'personal' }], availableModels: ['personal'], keep: true });
    await syncModels(file, models, 'local', 'key', { allowEmpty: true });
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).models.length, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('failed models disappear from API and cached callers cannot execute them', async () => {
  let published = models, calls = 0, recorded = 0;
  const server = createServer({ key: 'test', getModels: () => published,
    backend: { complete: async () => { calls++; throw new Error('insufficient_quota'); } },
    onResult: async (_, ok) => { assert.equal(ok, false); recorded++; published = []; }, status: () => ({}) });
  const base = await listen(server);
  const headers = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
  const request = () => fetch(base + '/v1/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    assert.equal((await request()).status, 502);
    assert.deepEqual((await (await fetch(base + '/v1/models', { headers })).json()).data, []);
    assert.equal((await request()).status, 400);
    assert.equal(calls, 1); assert.equal(recorded, 1);
    assert.equal(models.length, 1, 'UI discovery catalog is retained');
  } finally { server.closeAllConnections(); server.close(); }
});
