import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawMaterial, repairBody } from '../src/repair.js';
import { Backend } from '../src/backend.js';
import { prepare } from '../src/protocol.js';

const tools = [{ type: 'function', function: { name: 'Write', description: 'Write the complete file. The path may be relative to the external workspace.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } } }];

test('repair receives intact long Write material, conversation and receiver descriptions', () => {
  // Sizes and camelCase field mirror the retained WorkBuddy Write failure; no user file content.
  const content = 'x'.repeat(46649);
  const call = { name: 'Write', arguments: { filePath: '/external/slides.html', content } };
  const conversation = [{ role: 'user', content: 'Use /external as the workspace.' }, ...Array.from({ length: 7 }, () => ({ role: 'assistant', content: 'working' })),
    { role: 'assistant', content: null, tool_calls: [{ id: 'previous', type: 'function', function: { name: 'Write', arguments: JSON.stringify(call.arguments) } }] },
    { role: 'tool', tool_call_id: 'previous', content: 'Write error: file_path expected string, received undefined' }];
  const response = { info: { finish: 'length' }, parts: [{ type: 'tool', tool: 'StructuredOutput', state: { status: 'completed', input: { content: '', calls: [call] } } }] };
  const material = rawMaterial(response, { text: JSON.stringify(conversation) });
  const sent = JSON.parse(repairBody({ shape: 'envelope', tools, material }));
  assert.deepEqual(sent.material.parts[0].state.input.calls[0], call);
  assert.deepEqual(sent.material.conversation, conversation);
  assert.equal(sent.tools[0].description, tools[0].function.description);
});

test('translation can explicitly decline incomplete material and return control to the original model', async () => {
  const models = [{ id: 'opencode/test' }];
  const request = prepare({ model: models[0].id, tools, messages: [{ role: 'user', content: 'Write the file.' }] }, models);
  const backend = new Backend('http://unused', 'test');
  backend.translator = () => 'opencode/translator';
  let sessions = 0, turns = 0;
  const sent = [];
  backend.request = async (route, method, payload) => {
    if (route === '/session') return { id: `s${sessions++}` };
    if (route.endsWith('/message')) {
      if (route.startsWith('/session/s0/')) sent.push(payload.parts[0].text);
      if (route.startsWith('/session/s1/')) return { parts: [{ type: 'text', text: '{"unrepairable":true,"reason":"Write.content is missing; resend the complete file body."}' }] };
      turns++;
      if (turns < 3) return { info: { structured: { content: 5, calls: [] } }, parts: [] };
      return { info: { structured: { content: '', calls: [{ name: 'Write', arguments: { file_path: '/external/file', content: 'complete' } }] } }, parts: [] };
    }
    return [];
  };
  const meta = {};
  const result = await backend.complete(request, undefined, meta);
  assert.equal(turns, 3);
  assert.match(sent.at(-1), /Write.content is missing/);
  assert.equal(meta.repaired.envelope.reason, 'insufficient material');
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'Write');
});


test('a blocked action that cannot be repaired asks the original model for the missing detail', async () => {
  const models = [{ id: 'opencode/test' }];
  const request = prepare({ model: models[0].id, tools, messages: [{ role: 'user', content: 'Write the complete file.' }] }, models);
  const backend = new Backend('http://unused', 'test');
  backend.translator = () => 'opencode/translator';
  backend.toolParts.set('missing', { tool: 'write', input: { filePath: '/external/file' } });
  let sessions = 0, turns = 0, permission = true;
  const sent = [];
  backend.request = async (route, method, payload) => {
    if (route === '/session') return { id: `s${sessions++}` };
    if (route === '/permission') {
      if (!permission) return [];
      permission = false;
      return [{ id: 'p', sessionID: 's0', tool: { callID: 'missing' } }];
    }
    if (route.endsWith('/message')) {
      if (route.startsWith('/session/s1/')) return { parts: [{ type: 'text', text: '{"unrepairable":true,"reason":"Write.content is missing; resend full content."}' }] };
      turns++; sent.push(payload.parts[0].text);
      return { info: { structured: turns === 1 ? { content: 'Writing next.', calls: [] }
        : { content: '', calls: [{ name: 'Write', arguments: { file_path: '/external/file', content: 'complete' } }] } }, parts: [] };
    }
    return [];
  };
  const result = await backend.complete(request, undefined, {});
  assert.equal(turns, 2);
  assert.match(sent[1], /Write.content is missing/);
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'Write');
});
