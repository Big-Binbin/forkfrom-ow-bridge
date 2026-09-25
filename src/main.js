import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { findRuntime, startBackend, PINNED_VERSION } from './runtime.js';
import { createServer } from './server.js';
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
let models = [], server, runtime, stopping = false, refreshing;
let state = { phase: 'starting', message: '正在启动', endpoint, pid: process.pid, version: '0.1.0', opencodeVersion: PINNED_VERSION, models: [], modelResults: {}, sync: null };
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
const modelsFile = process.env.BUDDY_MODELS_FILE || path.join(os.homedir(), '.workbuddy/models.json');

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const discovered = await runtime.backend.models();
    let sync;
    if (process.env.BUDDY_NO_SYNC !== '1') {
      try { sync = await syncModels(modelsFile, discovered, `${endpoint}/chat/completions`, key); }
      catch (e) { sync = { error: e.message }; }
    } else sync = { skipped: true };
    models = discovered;
    update({ phase: 'ready', message: sync.error ? `代理已启动；模型同步失败：${sync.error}` : `运行中 · ${models.length} 个免费模型`, models, sync });
    return { models, sync };
  })();
  try { return await refreshing; }
  finally { refreshing = null; }
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  server?.abortAll(); server?.closeAllConnections(); server?.close();
  await runtime?.stop();
  if (code === 0) update({ phase: 'stopped', message: '已停止' });
  await statusWrites;
  log.end(); await fs.unlink(lockFile).catch(() => {});
  process.exit(code);
}
process.on('SIGTERM', () => shutdown()); process.on('SIGINT', () => shutdown());
process.on('uncaughtException', e => { update({ phase: 'error', message: e.message }); shutdown(1); });
process.on('unhandledRejection', e => { update({ phase: 'error', message: String(e?.message || e) }); shutdown(1); });
try {
  update({ phase: 'starting' });
  const binary = await findRuntime(dataDir, message => update({ message }));
  update({ message: '正在启动隔离模型服务' });
  runtime = await startBackend(binary, dataDir, log);
  runtime.child.on('exit', () => { if (!stopping) { update({ phase: 'error', message: 'OpenCode 服务退出，请重启代理' }); shutdown(1); } });
  // Confirm this runtime has the dedicated agent, not a user's build agent.
  const agents = await runtime.backend.request('/agent');
  if (!agents.some(a => a.name === 'buddy-bridge')) throw new Error('Dedicated approval-gated agent missing');
  server = createServer({ key, backend: runtime.backend, getModels: () => models, refresh,
    status: () => state, onResult: (model, ok, error) => {
      const result = { model, ok, ...(error ? { error } : {}), time: new Date().toISOString() };
      update({ lastRequest: result, ...(model ? { modelResults: { ...state.modelResults, [model]: result } } : {}) });
    } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await refresh();
  console.log(`Buddy Bridge ready at ${endpoint}; ${models.length} free models`);
} catch (e) { update({ phase: 'error', message: e.message }); await shutdown(1); }
