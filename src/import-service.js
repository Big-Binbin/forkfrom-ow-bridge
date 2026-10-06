// Import and removal of bridged models across every supported client.
//
// One call targets one client: the JSON clients merge into their config file, the VS Code
// family writes into its state database. Both paths share the same guarantees the original
// WorkBuddy-only implementation had: this app's entries are marked and replaced, the user's own
// entries are preserved, the file is backed up before writing, and an unchanged result writes
// nothing at all.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseJson } from './json.js';
import { replaceWithRetry } from './atomic.js';
import { writeTraeModels, removeTraeModels } from './trae-store.js';
import { createClients, OWNER, GROUPS } from './clients.js';
import { clientModelID } from './model-status.js';

const LOCK_STALE_MS = 5 * 60 * 1000;

// Write a file through a temporary name so a reader never observes a half-written config.
export async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, text, { mode: 0o600, flag: 'wx' });
    await replaceWithRetry(temp, file);
  } finally { await fs.unlink(temp).catch(() => {}); }
}

// A stale lock from a crashed run must not block every later import. The lock lives next to the
// config, so its directory is created first; a genuine conflict is a second concurrent import.
async function withLock(file, run) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockFile = `${file}.ow-bridge.lock`;
  await fs.stat(lockFile).then(async stat => {
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) await fs.unlink(lockFile).catch(() => {});
  }, () => {});
  const handle = await fs.open(lockFile, 'wx', 0o600).catch(() => {
    throw new Error('该客户端正在导入中，本次未做任何修改');
  });
  try { return await run(); }
  finally { await handle.close(); await fs.unlink(lockFile).catch(() => {}); }
}

// Read a JSON client config, or null when the file is absent. A config whose top level matches
// none of the supported shapes is refused rather than overwritten with our own.
async function readJson(file, { requireExisting = false } = {}) {
  const text = await fs.readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT' && !requireExisting) return null;
    throw error;
  });
  if (text === null) return null;
  const document = parseJson(text);
  const known = Array.isArray(document) || Array.isArray(document?.models)
    || typeof document?.config?.providerConfigRules === 'object';
  if (!known) throw new Error('无法识别该客户端的配置格式，未做修改');
  return document;
}

// Import models into one client. Returns { changed, count, label, note }.
export async function importIntoClient(client, models, endpoint, key, { requireExisting = false } = {}) {
  const file = client.locate({ env: process.env });
  if (!file) throw new Error(`未找到 ${client.label} 的配置位置`);
  if (client.kind === 'vscdb') {
    const result = await writeTraeModels(file, models, endpoint);
    return { ...result, label: client.label, id: client.id, needsKey: true, note: client.note, apiKey: key };
  }
  return withLock(file, async () => {
    const document = await readJson(file, { requireExisting });
    // Merge against an empty document when the client has no config yet.
    const base = document ?? (client.id === 'zcode' ? { config: {} } : []);
    const result = client.merge(base, models, endpoint, key);
    const next = result.document;
    const text = JSON.stringify(next, null, 2) + '\n';
    if (JSON.stringify(next) === JSON.stringify(base)) return { changed: false, count: models.length, label: client.label, id: client.id };
    // Re-read before writing: a client rewriting its own file mid-import must not be clobbered.
    const current = await fs.readFile(file, 'utf8').catch(error => {
      if (error.code === 'ENOENT' && !requireExisting) return null;
      throw error;
    });
    if (current !== null && JSON.stringify(parseJson(current)) !== JSON.stringify(base))
      throw new Error(`${client.label} 配置在导入过程中被修改，请重试`);
    let backup;
    if (current !== null) {
      backup = `${file}.ow-bridge-${Date.now()}.bak`;
      await fs.writeFile(backup, current, { mode: 0o600, flag: 'wx' });
    }
    await atomicWrite(file, text);
    return { changed: true, count: models.length, label: client.label, id: client.id, ...(backup ? { backup } : {}) };
  });
}

// Remove this app's entries from one client. Used on exit and when switching targets.
export async function removeFromClient(client, models, endpoint, key, options = {}) {
  const file = client.locate({ env: process.env });
  if (!file) return { changed: false, count: 0, label: client.label, id: client.id };
  if (client.kind === 'vscdb') {
    const result = await removeTraeModels(file, models.map(m => clientModelID(m)));
    return { ...result, label: client.label, id: client.id };
  }
  return withLock(file, async () => {
    const document = await readJson(file, { requireExisting: false });
    if (document === null) return { changed: false, count: 0, label: client.label, id: client.id };
    const result = client.merge(document, [], endpoint, key);
    const text = JSON.stringify(result.document, null, 2) + '\n';
    if (JSON.stringify(result.document) === JSON.stringify(document)) return { changed: false, count: 0, label: client.label, id: client.id };
    await atomicWrite(file, text);
    return { changed: true, count: 0, label: client.label, id: client.id };
  });
}

// Report which clients are installed, so the UI can list targets without guessing.
export async function detectClients({ env = process.env, home, platform = process.platform } = {}) {
  const list = createClients({ env, home, platform });
  const out = [];
  for (const client of list) {
    const file = client.locate({ env, home, platform });
    const installed = file ? await fs.stat(file).then(s => s.isFile(), () => false) : false;
    out.push({ id: client.id, label: client.label, group: client.group, auto: client.auto, installed, ...(client.note ? { note: client.note } : {}) });
  }
  return out;
}

export { createClients, OWNER, GROUPS };