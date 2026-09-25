import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { findRuntime, startBackend, PINNED_VERSION } from './runtime.js';
import { createServer } from './server.js';
import { prepare } from './protocol.js';
import { modelResult } from './model-status.js';
import { atomicWrite, syncModels } from './sync.js';

const dataDir = process.env.BUDDY_DATA_DIR || path.join(os.homedir(), 'Library/Application Support/Buddy Bridge');
const port = Number(process.env.BUDDY_PORT || 41980);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid BUDDY_PORT');
await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
const lockFile = path.join(dataDir, 'service.pid');
try {
  const pid = Number(await fs.readFile(lockFile, 'utf8'));
  try { process.kill(pid, 0); console.error('Buddy Bridge is already running'); process.exit(2); }
  catch (e) { if (e.code !== 'ESRCH') throw e; }
  await fs.unlink(lockFile);
} catch (e) { if (e.code !== 'ENOENT') throw e; }
await fs.writeFile(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
const tokenFile = path.join(dataDir, 'api-key');
let key;
try { key = (await fs.readFile(tokenFile, 'utf8')).trim(); }
catch (e) { if (e.code !== 'ENOENT') throw e; key = randomBytes(32).toString('hex'); await fs.writeFile(tokenFile, key, { flag: 'wx', mode: 0o600 }); }
const endpoint = `http://127.0.0.1:${port}/v1`;
let models = [], server, runtime, binary, stopping = false, refreshing;
let previous = {};
try { previous = JSON.parse(await fs.readFile(path.join(dataDir, 'status.json'), 'utf8')); } catch {}
let state = { phase: 'starting', message: '正在启动', endpoint, pid: process.pid, version: '0.1.0', opencodeVersion: PINNED_VERSION, models: [], modelResults: previous.modelResults || {}, sync: null, availableModels: [], probe: { running: false } };
// Serialize status writes so an older async update cannot overwrite a newer state.
let statusWrites = Promise.resolve();
function update(patch) {
  state = { ...state, ...patch, updatedAt: new Date().toISOString() };
  const text = JSON.stringify(state, null, 2);
  statusWrites = statusWrites.then(() => atomicWrite(path.join(dataDir, 'status.json'), text)).catch(e => console.error('Status write failed:', e.message));
}
const logFile = path.join(dataDir, 'opencode.log');
try { if ((await fs.stat(logFile)).size > 5 * 1024 * 1024) await fs.rename(logFile, logFile + '.previous'); } catch {}
const log = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
const validated = new Set();
const publishedModels = () => models.filter(m => validated.has(m.id) && state.modelResults[m.id]?.ok === true);
let syncWrites = Promise.resolve();
const modelsFile = process.env.BUDDY_MODELS_FILE || path.join(os.homedir(), '.workbuddy/models.json');

function syncPublished(published = publishedModels()) {
  syncWrites = syncWrites.then(async () => {
    let sync;
    if (process.env.BUDDY_NO_SYNC === '1') sync = { skipped: true, count: published.length };
    else {
      try { sync = await syncModels(modelsFile, published, `${endpoint}/chat/completions`, key, { allowEmpty: true }); }
      catch (e) { sync = { error: e.message }; }
    }
    update({ sync: { ...sync, time: new Date().toISOString() } });
    return sync;
  });
  return syncWrites;
}
async function record(model, ok, error, status, code, durationMs, source = 'request') {
  if (stopping) return;
  const result = { model, ...modelResult(ok, error, status, code), durationMs, source };
  if (ok) validated.add(model); else validated.delete(model);
  update({ lastRequest: result, ...(model ? { modelResults: { ...state.modelResults, [model]: result } } : {}) });
  update({ availableModels: publishedModels().map(m => m.id) });
}
let probing = false, probeTask;
const probeAbort = new AbortController();
function startProbes(modelID, reveal = false, autoImport = false) {
  if (stopping || refreshing) throw new Error('请等待模型读取完成');
  if (probing) return { started: false, message: '检测正在进行' };
  const selected = modelID ? models.filter(m => m.id === modelID) : models;
  if (!selected.length) throw new Error('模型不在当前目录中');
  probing = true;
  const pending = selected.map(model => model.id);
  probeTask = (async () => {
    try {
      for (const model of selected) {
        if (stopping) break;
        update({ ...(reveal ? { models: [...state.models, model] } : {}), probe: { running: true, current: model.id, pending: [...pending] } });
        const started = performance.now();
        try {
          await runtime.backend.complete(prepare({ model: model.id, messages: [{ role: 'user', content: 'Reply only OK.' }], tool_choice: 'none' }, models), AbortSignal.any([probeAbort.signal, AbortSignal.timeout(30000)]));
          await record(model.id, true, undefined, undefined, undefined, Math.round(performance.now() - started), 'probe');
        } catch (e) { if (!stopping) await record(model.id, false, e.name === 'TimeoutError' ? 'Model probe timed out' : e.message, e.status, e.code, Math.round(performance.now() - started), 'probe'); }
        pending.shift();
        update({ probe: { running: true, pending: [...pending] } });
      }
      if (autoImport && !stopping) await syncPublished();
    } finally { probing = false; update({ probe: { running: false } }); }
  })().catch(e => console.error('Model detection failed:', e.message));
  return { started: true };
}

function watchRuntime(current) {
  current.child.on('exit', () => {
    if (!stopping && runtime === current) {
      update({ phase: 'error', message: 'OpenCode 服务退出，请重启代理' });
      shutdown(1);
    }
  });
}

async function refresh(restartRuntime = false) {
  if (refreshing) return refreshing;
  if (probing || stopping) throw new Error('请等待检测完成');
  validated.clear();
  models = [];
  update({ phase: 'reading', message: '正在读取免费模型…', models: [], availableModels: [] });
  refreshing = (async () => {
    if (restartRuntime) {
      const next = await startBackend(binary, dataDir, log);
      if (stopping) { await next.stop(); return; }
      const old = runtime;
      runtime = next;
      watchRuntime(next);
      await old.stop();
    }
    const discovered = await runtime.backend.models();
    if (stopping) return;
    models = discovered;
    update({ phase: 'ready', message: `运行中 · ${models.length} 个免费模型` });
    return { count: models.length };
  })();
  try { return await refreshing; }
  catch (e) { if (!stopping) update({ phase: 'error', message: `读取失败：${e.message}` }); throw e; }
  finally { refreshing = null; }
}

async function readModels() {
  const result = await refresh(true);
  if (!stopping) startProbes(undefined, true);
  return result;
}
async function importModels() {
  if (stopping || probing || refreshing || state.phase !== 'ready') throw new Error('请等待读取和检测完成后导入');
  const sync = await syncPublished();
  if (sync.error) throw new Error(sync.error);
  return sync;
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  probeAbort.abort();
  server?.abortAll(); server?.closeAllConnections(); server?.close();
  await syncPublished([]);
  await runtime?.stop();
  await refreshing?.catch(() => {});
  await probeTask;
  if (code === 0) update({ phase: 'stopped', message: '已停止' });
  await syncWrites;
  await statusWrites;
  log.end(); await fs.unlink(lockFile).catch(() => {});
  process.exit(code);
}
process.on('SIGTERM', () => shutdown()); process.on('SIGINT', () => shutdown());
process.on('uncaughtException', e => { update({ phase: 'error', message: e.message }); shutdown(1); });
process.on('unhandledRejection', e => { update({ phase: 'error', message: String(e?.message || e) }); shutdown(1); });
try {
  update({ phase: 'starting' });
  await syncPublished([]);
  binary = await findRuntime(dataDir, message => update({ message }));
  update({ message: '正在启动隔离模型服务' });
  runtime = await startBackend(binary, dataDir, log);
  watchRuntime(runtime);
  // Confirm this runtime has the dedicated agent, not a user's build agent.
  const agents = await runtime.backend.request('/agent');
  if (!agents.some(a => a.name === 'buddy-bridge')) throw new Error('Dedicated approval-gated agent missing');
  server = createServer({ key, backend: { complete: (...args) => runtime.backend.complete(...args) }, getModels: publishedModels, refresh: readModels, importModels,
    status: () => state, probe: startProbes, onResult: record });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await refresh();
  startProbes(undefined, true, true);
  console.log(`Buddy Bridge ready at ${endpoint}; ${models.length} free models`);
} catch (e) { update({ phase: 'error', message: e.message }); await shutdown(1); }
