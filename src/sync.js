import { clientModelID } from './model-status.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const OWNER = 'buddy-bridge-v1';
export async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.unlink(temp).catch(() => {}); }
}

export function mergeModels(document, models, endpoint, key, { allowEmpty = false } = {}) {
  if (!models.length && !allowEmpty) throw new Error('Empty model discovery; existing configuration preserved');
  const list = Array.isArray(document) ? document : document?.models;
  if (!Array.isArray(list)) throw new Error('Unrecognized WorkBuddy models.json; left unchanged');
  const kept = list.filter(m => m.buddyBridgeOwner !== OWNER);
  const conflicts = new Set(kept.map(m => m.id));
  const entries = models.filter(m => !conflicts.has(m.id) && !conflicts.has(clientModelID(m))).map(m => ({
    id: clientModelID(m), name: clientModelID(m), vendor: 'Custom', url: endpoint, apiKey: key,
    supportsToolCall: true, supportsImages: false, supportsReasoning: false,
    buddyBridgeOwner: OWNER,
    ...(m.context ? { maxInputTokens: m.context } : {}),
    ...(m.output ? { maxOutputTokens: m.output } : {}),
  }));
  const combined = [...kept, ...entries];
  if (Array.isArray(document)) return combined;
  const updated = { ...document, models: combined };
  if (Array.isArray(document.availableModels)) {
    const old = new Set(list.filter(m => m.buddyBridgeOwner === OWNER).map(m => m.id));
    updated.availableModels = [...new Set([...document.availableModels.filter(id => !old.has(id)), ...entries.map(m => m.id)])];
  }
  return updated;
}

export async function syncModels(file, models, endpoint, key, options = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = await fs.open(`${file}.buddy-bridge.lock`, 'wx', 0o600).catch(() => { throw new Error('Model sync already running; no changes made'); });
  try {
    const old = await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    const document = old === null ? [] : JSON.parse(old);
    const merged = mergeModels(document, models, endpoint, key, options);
    if (JSON.stringify(merged) === JSON.stringify(document)) return { changed: false, count: models.length };
    const current = await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (current !== old) throw new Error('WorkBuddy configuration changed during sync; retry refresh');
    let backup;
    if (old !== null) {
      backup = `${file}.buddy-bridge-${Date.now()}.bak`;
      await fs.writeFile(backup, old, { mode: 0o600, flag: 'wx' });
    }
    await atomicWrite(file, JSON.stringify(merged, null, 2) + '\n');
    return { changed: true, count: models.length, backup };
  } finally { await lock.close(); await fs.unlink(`${file}.buddy-bridge.lock`).catch(() => {}); }
}
