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
      if (request.tools.length) return { model: request.model.id, choices: [{ message: { tool_calls: [{ function: { name: 'bridge_probe', arguments: JSON.stringify({ token: request.tools[0].function.parameters.properties.token.const }) } }] } }] };
      return { model: request.model.id, choices: [{ message: { role: 'assistant', content: 'OK' } }] };
    },
  } };
}
