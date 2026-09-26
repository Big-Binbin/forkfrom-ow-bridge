import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
export const PINNED_VERSION = 'test';
export async function findRuntime() { return 'test'; }
export async function startBackend(_, dataDir) {
  const child = new EventEmitter();
  const read = async () => JSON.parse(await fs.readFile(path.join(dataDir, 'catalog.json'), 'utf8'));
  return { child, stop: async () => child.emit('exit'), backend: {
    request: async () => [{ name: 'buddy-bridge' }],
    models: async () => (await read()).models,
    complete: async request => {
      await new Promise(resolve => setTimeout(resolve, 250));
      if ((await read()).chatOnly?.includes(request.model.id) && !request.chatOnly) throw Object.assign(new Error('only auto is supported for tool_choice'), { code: 'model_error' });
      if ((await read()).failed.includes(request.model.id)) throw new Error('insufficient_quota');
      if (!request.tools.length && (await read()).formatError) throw Object.assign(new Error('Invalid model response envelope'), { code: 'invalid_model_output' });
      if (request.tools.length) {
        const token = (JSON.parse(request.text)[0].content.match(/probe-([0-9a-f]+)\.txt/) || [])[1] || 'unknown';
        return { model: request.model.id, choices: [{ message: { content: null, tool_calls: [{ id: 'call_probe', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: `/external/probe-${token}.txt` }) } }] } }] };
      }
      return { model: request.model.id, choices: [{ message: { role: 'assistant', content: 'OK' } }] };
    },
  } };
}
