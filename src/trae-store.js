// Writer for the VS Code state database used by the Trae-family clients.
//
// Those clients are VS Code forks, so their model lists live in a SQLite database at
// %APPDATA%\<client>\User\globalStorage\state.vscdb, table ItemTable, under a key shaped
// "<numeric-user-id>_AI.agent.model.model_list_map".
//
// Two facts shape this file:
//  - the database belongs to a running client, so every edit is made on a copy which is then
//    swapped in; a failed or refused import leaves the original untouched;
//  - the API key column (ak) is encrypted with a client-owned scheme we cannot reproduce, so
//    entries are written keyless and the user completes them inside the client UI.
import fs from 'node:fs/promises';
import { parseJson } from './json.js';
import { TRAE_GROUPS, traeEntry } from './clients.js';

const MODEL_KEY_SUFFIX = '_AI.agent.model.model_list_map';
const SELECT_KEYS = `SELECT key, value FROM ItemTable WHERE key LIKE '%${MODEL_KEY_SUFFIX}'`;

// node:sqlite is built in from Node 22.5 (experimental, needing a flag) and stable from 24.
// It is loaded lazily so an unsupported runtime fails with a clear message when a Trae-family
// client is actually targeted, instead of breaking startup for every other client.
let DatabaseSync;
let sqliteChecked = false;
async function openDatabase(file, options) {
  if (!DatabaseSync && !sqliteChecked) {
    sqliteChecked = true;
    // Loaded lazily so an unsupported runtime fails with a clear message when a Trae-family
    // client is actually targeted, instead of breaking startup for every other client.
    try { ({ DatabaseSync } = await import('node:sqlite')); }
    catch { throw new Error('当前运行环境缺少 node:sqlite，无法写入 Trae / Qoder 客户端。请使用 Node.js 24 或更高版本。'); }
  }
  if (!DatabaseSync) throw new Error('当前运行环境缺少 node:sqlite，无法写入 Trae / Qoder 客户端。请使用 Node.js 24 或更高版本。');
  // DatabaseSync rejects a missing options argument, so default it.
  return new DatabaseSync(file, options ?? {});
}

// Edit a copy of the database and return the rewritten bytes, or null when nothing changed.
async function editCopy(file, edit) {
  const temporary = `${file}.ow-bridge-${Date.now()}.tmp`;
  await fs.copyFile(file, temporary);
  let changed = false;
  let db;
  try {
    db = await openDatabase(temporary);
    const rows = db.prepare(SELECT_KEYS).all();
    if (!rows.length) throw new Error('未在该客户端中找到模型配置，请确认已登录并使用过一次对话');
    for (const row of rows) {
      const document = parseJson(String(row.value));
      const next = edit(document);
      if (JSON.stringify(next) === JSON.stringify(document)) continue;
      db.prepare('UPDATE ItemTable SET value = ? WHERE key = ?').run(JSON.stringify(next), row.key);
      changed = true;
    }
  } finally { db?.close(); }
  if (!changed) { await fs.unlink(temporary).catch(() => {}); return null; }
  try {
    return await fs.readFile(temporary);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

// Swap the rewritten database in, keeping a timestamped copy of the original beside it so the
// user can undo by hand if the client turns out to dislike the entry.
async function replace(file, bytes) {
  const backup = `${file}.ow-bridge-${Date.now()}.bak`;
  await fs.copyFile(file, backup);
  const temporary = `${file}.ow-bridge-${Date.now()}.new`;
  await fs.writeFile(temporary, bytes);
  try { await fs.rename(temporary, file); }
  catch (error) {
    // A running client holds the database open; Windows refuses the rename, so fall back to
    // overwriting the contents in place.
    await fs.unlink(temporary).catch(() => {});
    await fs.writeFile(file, bytes);
    throw Object.assign(new Error(`已写入配置，但未能替换原文件（客户端正在运行？）：${error.message}`), { backup });
  }
  return backup;
}

// Insert this app's entries into a Trae model list and drop previously imported ones.
// Entries are matched by model name, so a user's own custom models are never touched.
export function mergeGroups(list, entries) {
  const ours = new Set(entries.map(e => e.name));
  const kept = (Array.isArray(list) ? list : []).filter(m => !ours.has(m?.name));
  return [...kept, ...entries];
}

// Apply a per-group edit across every agent group of a Trae model list.
function editGroups(document, edit) {
  let next = document;
  for (const group of TRAE_GROUPS) {
    const list = Array.isArray(next[group]) ? next[group] : [];
    next = { ...next, [group]: edit(list) };
  }
  return next;
}

// Write bridged models into a Trae-family client's state database.
export async function writeTraeModels(file, models, endpoint) {
  const entries = models.map(model => traeEntry(model, endpoint));
  const bytes = await editCopy(file, document => editGroups(document, list => mergeGroups(list, entries)));
  if (!bytes) return { changed: false, count: entries.length, groups: TRAE_GROUPS.length };
  const backup = await replace(file, bytes);
  return { changed: true, count: entries.length, groups: TRAE_GROUPS.length, backup };
}

// Remove this app's entries from a Trae-family client's state database.
export async function removeTraeModels(file, modelIDs) {
  const names = new Set(modelIDs.map(id => `custom_openai_compatible//${id}`));
  const bytes = await editCopy(file, document => editGroups(document, list => list.filter(m => !names.has(m?.name))));
  if (!bytes) return { changed: false, count: 0 };
  const backup = await replace(file, bytes);
  return { changed: true, count: modelIDs.length, backup };
}

// Whether a client database currently exists on this machine.
export async function exists(file) {
  return fs.stat(file).then(s => s.isFile(), () => false);
}