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
      if ((await read()).failed.includes(request.model.id)) throw new Error('insufficient_quota');
      return { model: request.model.id, choices: [{ message: { role: 'assistant', content: 'OK' } }] };
    },
  } };
}
