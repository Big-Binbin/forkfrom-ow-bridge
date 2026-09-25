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
  assert.throws(() => prepare({ ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }, models), /does not declare image input/);
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
    assert.deepEqual(merged.availableModels, ['personal', 'OC · Test']);
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
    assert.equal((await (await fetch(base + '/v1/models', { headers })).json()).data[0].id, 'OC · Test');
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

test('response timings cover completed and failed upstream requests', async () => {
  let fail = false;
  const recorded = [];
  const server = createServer({ key: 'test', getModels: () => models,
    backend: { complete: async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      if (fail) throw new Error('timed out');
      return completion(body.model, { role: 'assistant', content: 'OK' });
    } },
    onResult: async (...args) => { recorded.push(args); }, status: () => ({}) });
  const base = await listen(server);
  const request = () => fetch(base + '/v1/chat/completions', { method: 'POST',
    headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await request()).status, 200);
    fail = true;
    assert.equal((await request()).status, 502);
    assert.deepEqual(recorded.map(args => args[1]), [true, false]);
    for (const args of recorded) assert.ok(Number.isInteger(args[5]) && args[5] >= 30, 'Includes upstream wait on both outcomes');
  } finally { server.closeAllConnections(); server.close(); }
});


test('short client IDs display once, route to upstream IDs and preserve manual collisions', () => {
  const entries = mergeModels([], models, 'local', 'key');
  assert.equal(entries[0].id, 'OC · Test');
  assert.equal(entries[0].name, entries[0].id);
  assert.equal(prepare({ ...body, model: entries[0].id }, models).model.id, models[0].id);
  assert.throws(() => prepare({ ...body, model: entries[0].id }, []), /available free/);
  const manual = { id: entries[0].id, apiKey: 'mine' };
  assert.deepEqual(mergeModels([manual], models, 'local', 'key'), [manual]);
  const legacy = [{ id: models[0].id, buddyBridgeOwner: OWNER }];
  assert.deepEqual(mergeModels(legacy, models, 'local', 'key'), entries);
});


test('discovery preserves provider names for existing and newly added models', () => {
  const entry = name => ({ name, cost: { input: 0, output: 0 }, capabilities: { toolcall: true } });
  const discovered = freeModels({ all: [{ id: 'opencode', models: {
    'mimo-v2.6-flash-free': entry('MiMo-V2.6-Flash'),
    'future-model-free': entry('Future Model Preview'),
    'no-name': entry(undefined),
  } }] });
  assert.equal(discovered.find(m => m.id.endsWith('/mimo-v2.6-flash-free')).name, 'MiMo-V2.6-Flash');
  assert.equal(discovered.find(m => m.id.endsWith('/future-model-free')).name, 'Future Model Preview');
  assert.equal(discovered.find(m => m.id.endsWith('/no-name')).name, 'no-name');
});

test('chat-only models preserve text without structured formatting and reject tool requests', async () => {
  const chatModels = [{ ...models[0], chatOnly: true }];
  assert.throws(() => prepare(body, chatModels), /仅支持普通对话/);
  let sent;
  const backend = new Backend('http://unused', 'test');
  backend.request = async (route, method, data) => {
    if (route === '/session') return { id: 'chat' };
    if (route === '/permission') return [];
    if (route.endsWith('/message')) { sent = data; return { info: {}, parts: [{ type: 'text', text: 'Plain answer' }] }; }
    return true;
  };
  const result = await backend.complete(prepare({ model: models[0].id, messages: body.messages }, chatModels));
  assert.equal(sent.format, undefined);
  assert.equal(sent.agent, 'buddy-chat');
  assert.equal(result.choices[0].message.content, 'Plain answer');
  assert.equal(result.choices[0].message.tool_calls, undefined);
});

test('import fills capabilities and token limits from detected model metadata', () => {
  const result = mergeModels([{ id: 'personal' }], [{ ...models[0], chatOnly: true }], 'local', 'key');
  assert.equal(result[0].id, 'personal');
  assert.equal(result[1].supportsToolCall, false);
  assert.equal(result[1].supportsImages, false);
  assert.equal(result[1].supportsReasoning, false);
  assert.equal(result[1].maxInputTokens, 1000);
  assert.equal(result[1].maxOutputTokens, 500);
  assert.equal(mergeModels([], models, 'local', 'key')[0].supportsToolCall, true);
});


test('reasoning scan preserves variants; import advertises only mapped controls', () => {
  const discovered = freeModels({ all: [{ id: 'opencode', models: {
    test: { name: 'Test', cost: { input: 0, output: 0 }, capabilities: { reasoning: true },
      variants: { fast: { reasoningEffort: 'low' }, deep: { reasoningEffort: 'high' }, hidden: { reasoningEffort: 'max', disabled: true } } },
    default: { cost: { input: 0, output: 0 }, capabilities: { reasoning: true }, variants: {} },
  } }] });
  const model = discovered.find(m => m.id === 'opencode/test');
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.variants.fast, { reasoningEffort: 'low' });
  const imported = mergeModels([], discovered, 'local', 'key');
  const entry = imported.find(m => m.name === 'OC · Test');
  assert.equal(entry.supportsReasoning, true);
  assert.equal(entry.onlyReasoning, true);
  assert.equal(entry.reasoning.canDisableThinking, false);
  assert.deepEqual(entry.reasoning.supportedEfforts, ['low', 'high']);
  const fixed = imported.find(m => m.name === 'OC · default');
  assert.equal(fixed.supportsReasoning, true);
  assert.equal(fixed.onlyReasoning, true);
  assert.deepEqual(fixed.reasoning, { supportedEfforts: [], canDisableThinking: false });
  const fixedModel = discovered.find(m => m.id === 'opencode/default');
  assert.equal(prepare({ model: fixedModel.id, messages: body.messages }, [fixedModel]).variant, undefined);
  const request = { model: model.id, messages: body.messages };
  assert.equal(prepare(request, [model]).variant, undefined);
  assert.equal(prepare({ ...request, reasoning_effort: 'high' }, [model]).variant, 'deep');
  for (const effort of ['none', 'max', 'toString', {}]) {
    assert.throws(() => prepare({ ...request, reasoning_effort: effort }, [model]), /reasoning effort/);
  }
});

test('WorkBuddy fallback effort uses the default mode for fixed-reasoning models', async () => {
  const backend = new Backend('http://unused', 'test');
  let sent;
  backend.request = async (route, method, payload) => {
    if (route === '/session') return { id: 'fixed-reasoning' };
    if (route.endsWith('/message')) {
      sent = payload;
      return { parts: [{ type: 'text', text: 'OK' }] };
    }
    return [];
  };
  const model = { ...models[0], chatOnly: true, reasoning: true, variants: {} };
  for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    for (const field of [{ reasoning_effort: effort }, { reasoning: { effort } }]) {
      const request = prepare({ model: model.id, messages: body.messages, ...field }, [model]);
      await backend.complete(request);
      assert.equal(sent.variant, undefined, 'No unsupported variant is forwarded to OpenCode');
      assert.equal(prepare({ model: model.id, messages: body.messages, ...field }, [{ ...model, chatOnly: false }]).variant, undefined);
    }
  }
  for (const effort of ['none', 'invalid', {}])
    assert.throws(() => prepare({ model: model.id, messages: body.messages, reasoning_effort: effort }, [model]), /reasoning effort/);
  assert.throws(() => prepare({ model: model.id, messages: body.messages, reasoning_effort: 'high' }, [{ ...model, reasoning: false }]), /reasoning effort/);
});

test('reasoning selection reaches OpenCode for tool and plain chat requests', async () => {
  const backend = new Backend('http://unused', 'test');
  let sent;
  backend.request = async (route, method, data) => {
    if (route === '/session') return { id: 'reasoning' };
    if (route === '/permission') return [];
    if (route.endsWith('/message')) {
      sent = data;
      return { info: {}, parts: [{ type: 'text', text: data.agent === 'buddy-chat' ? 'OK' : '{"content":"OK","calls":[]}' }] };
    }
    return true;
  };
  for (const chatOnly of [false, true]) {
    const model = { ...models[0], chatOnly, reasoning: true, variants: { deep: { reasoningEffort: 'high' } } };
    await backend.complete(prepare({ model: model.id, messages: body.messages, reasoning: { effort: 'high' } }, [model]));
    assert.equal(sent.variant, 'deep');
  }
});

test('catalog capabilities and separate input/context limits drive import', () => {
  const discovered = freeModels({ all: [{ id: 'opencode', models: {
    vision: { name: 'Vision', cost: { input: 0, output: 0 }, limit: { context: 1000, input: 700, output: 300 }, capabilities: { input: { image: true } } },
    text: { cost: { input: 0, output: 0 }, limit: { context: 2000, output: 500 } },
  } }] });
  const vision = discovered.find(m => m.images);
  assert.equal(vision.context, 1000);
  assert.equal(vision.input, 700);
  const entries = mergeModels([], discovered, 'local', 'key');
  assert.equal(entries.find(m => m.name === 'OC · Vision').supportsImages, true);
  assert.equal(entries.find(m => m.name === 'OC · Vision').maxInputTokens, 700);
  assert.equal(entries.find(m => m.name === 'OC · text').maxInputTokens, 2000);
  assert.equal(entries.find(m => m.name === 'OC · text').supportsImages, false);
});

test('image attachments preserve history mapping in both tool and chat paths', async () => {
  const url = 'data:image/png;base64,iVBORw0KGgo=';
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'First' }, { type: 'image_url', image_url: { url } }] },
    { role: 'assistant', content: 'Seen' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url } }, { type: 'text', text: 'Compare' }] },
  ];
  const backend = new Backend('http://unused', 'test');
  let sent;
  backend.request = async (route, method, data) => {
    if (route === '/session') return { id: 'vision' };
    if (route === '/permission') return [];
    if (route.endsWith('/message')) {
      sent = data;
      return { info: {}, parts: [{ type: 'text', text: data.agent === 'buddy-chat' ? 'OK' : '{"content":"OK","calls":[]}' }] };
    }
    return true;
  };
  for (const chatOnly of [true, false]) {
    const request = prepare({ model: models[0].id, messages }, [{ ...models[0], images: true, chatOnly }]);
    assert.equal(request.text.includes('base64'), false);
    assert.match(JSON.parse(request.text)[0].content, /message-1-image-2.png/);
    assert.match(JSON.parse(request.text)[2].content, /message-3-image-1.png/);
    await backend.complete(request);
    assert.deepEqual(sent.parts.slice(1), request.images);
    assert.equal(sent.parts[1].url, url);
    assert.match(sent.system, /Match each attachment filename/);
  }
  for (const bad of ['file:///etc/passwd', 'https://example.com/a.png', 'data:text/plain;base64,aGk=', 'data:image/png;base64,@@@']) {
    assert.throws(() => prepare({ model: models[0].id, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: bad } }] }] }, [{ ...models[0], images: true }]), /base64 data URLs/);
  }
});

test('a malformed response envelope gets one format-only correction before tools are emitted', async () => {
  const request = prepare(body, models);
  const malformed = { content: null, calls: [{ name: 'write_file', arguments: { path: 'x' } }] };
  assert.throws(() => decode(JSON.stringify(malformed), request), /Invalid model response envelope/);
  const backend = new Backend('http://unused', 'test');
  const sent = [];
  backend.request = async (route, method, payload) => {
    if (route === '/session') return { id: 'repair' };
    if (route.endsWith('/message')) {
      sent.push(payload);
      return { info: { structured: sent.length === 1 ? malformed : { content: '', calls: malformed.calls } }, parts: [] };
    }
    return [];
  };
  const result = await backend.complete(request);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].format, sent[0].format);
  assert.equal(sent[1].agent, 'buddy-bridge');
  assert.match(sent[1].parts[0].text, /No external tool has been executed/);
  assert.equal(result.choices[0].message.tool_calls.length, 1);
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'write_file');
});

test('format correction is bounded and never retries unsafe or invalid tool calls', async () => {
  for (const kind of ['malformed', 'unlisted', 'native', 'truncated']) {
    const backend = new Backend('http://unused', 'test');
    let calls = 0;
    backend.request = async route => {
      if (route === '/session') return { id: 'bounded' };
      if (route.endsWith('/message')) {
        calls++;
        if (kind === 'native') return { parts: [{ type: 'tool', tool: 'write' }] };
        if (kind === 'truncated') return { info: { finish: 'length' }, parts: [] };
        return { info: { structured: kind === 'malformed' ? {} : { content: '', calls: [{ name: 'unlisted', arguments: {} }] } }, parts: [] };
      }
      return [];
    };
    await assert.rejects(backend.complete(prepare(body, models)));
    assert.equal(calls, kind === 'malformed' ? 2 : 1);
  }
});
