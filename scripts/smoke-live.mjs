// Opt-in live test; uses the local proxy token and writes only into a fresh temporary directory.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const dataDir = process.env.BUDDY_DATA_DIR || path.join(os.homedir(), 'Library/Application Support/Buddy Bridge');
const status = JSON.parse(await fs.readFile(path.join(dataDir, 'status.json'), 'utf8'));
const key = (await fs.readFile(path.join(dataDir, 'api-key'), 'utf8')).trim();
const model = process.env.BUDDY_TEST_MODEL || 'opencode/space-bunny-free';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-live-'));
const file = path.join(root, 'bridge-smoke.txt');
const messages = [{ role: 'system', content: 'Use the provided tools to write bridge-smoke.txt with the exact text BUDDY_BRIDGE_OK, then read it back, then report the read content. Never claim an action until a tool result confirms it. Use relative paths.' }, { role: 'user', content: 'Create the test file, read it, and report the verified content.' }];
const tools = ['write_file', 'read_file'].map(name => ({ type: 'function', function: { name, description: name === 'write_file' ? 'Write a UTF-8 file' : 'Read a UTF-8 file', parameters: { type: 'object', properties: { path: { type: 'string' }, ...(name === 'write_file' ? { content: { type: 'string' } } : {}) }, required: name === 'write_file' ? ['path', 'content'] : ['path'], additionalProperties: false } } }));
let wrote = false, read = false, finished = false;
for (let turn = 0; turn < 6; turn++) {
  const start = Date.now();
  const response = await fetch(status.endpoint + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, tools, stream: true, parallel_tool_calls: false }), signal: AbortSignal.timeout(190000) });
  const raw = await response.text();
  if (!response.ok) throw new Error(raw);
  const events = raw.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
  if (events.some(e => e.error)) throw new Error(JSON.stringify(events.find(e => e.error).error));
  const message = { role: 'assistant', content: '' };
  for (const event of events) {
    const delta = event.choices?.[0]?.delta;
    if (delta?.content) message.content += delta.content;
    if (delta?.tool_calls) message.tool_calls = delta.tool_calls.map(({ index, ...call }) => call);
  }
  messages.push(message);
  console.log(`Turn ${turn + 1}: ${Date.now() - start}ms; tools=${message.tool_calls?.map(c => c.function.name).join(',') || 'none'}`);
  if (!message.tool_calls?.length) { assert.ok(wrote && read); assert.match(message.content, /BUDDY_BRIDGE_OK/); finished = true; break; }
  for (const call of message.tool_calls) {
    const args = JSON.parse(call.function.arguments);
    assert.equal(path.resolve(root, args.path), file, 'Only the smoke file may be accessed');
    let content;
    if (call.function.name === 'write_file') { assert.equal(args.content, 'BUDDY_BRIDGE_OK'); await fs.writeFile(file, args.content); content = 'File written successfully'; wrote = true; }
    else { assert.equal(call.function.name, 'read_file'); content = await fs.readFile(file, 'utf8'); read = true; }
    messages.push({ role: 'tool', tool_call_id: call.id, content });
  }
}
assert.ok(finished, 'Agent did not finish within six turns');
console.log(JSON.stringify({ ok: true, model, wrote, read, file }));
