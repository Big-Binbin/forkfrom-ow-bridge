import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveModelsFile, validateModelsFile } from './workbuddy-config.js';
import { dataDirectory } from './platform.js';
import { randomBytes } from 'node:crypto';
import { findRuntime, startBackend, PINNED_VERSION } from './runtime.js';
import { createServer } from './server.js';
import { systemProxyEnvironment } from './system-proxy.js';
import { prepare, BridgeError } from './protocol.js';
import { PROBE_TIMEOUT, probeBody, probeModel, probeFailure, formatUnsupported } from './probe.js';
import { modelResult, withRequestMeta } from './model-status.js';
import { atomicWrite, syncModels } from './sync.js';

const dataDir = process.env.BUDDY_DATA_DIR || dataDirectory();
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
const settingsFile = path.join(dataDir, 'settings.json');
let settings = {};
try { settings = JSON.parse(await fs.readFile(settingsFile, 'utf8')); } catch {}
const endpoint = `http://127.0.0.1:${port}/v1`;
let models = [], server, runtime, binary, stopping = false, refreshing;
let previous = {};
try { previous = JSON.parse(await fs.readFile(path.join(dataDir, 'status.json'), 'utf8')); } catch {}
let state = { useSystemProxy: settings.useSystemProxy === true, phase: 'starting', message: '正在启动', endpoint, pid: process.pid, version: '0.2.0', opencodeVersion: PINNED_VERSION, models: [], modelResults: previous.modelResults || {}, sync: null, availableModels: [], probe: { running: false } };
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
const usableModels = () => models.filter(m => validated.has(m.id) && state.modelResults[m.id]?.ok === true).map(m => ({ ...m, chatOnly: state.modelResults[m.id]?.chatOnly === true }));
const publishedModels = usableModels;
let syncWrites = Promise.resolve();
let modelsFile = process.platform === 'win32'
  ? await resolveModelsFile({ saved: settings.workBuddyModelsFile })
  : process.env.BUDDY_MODELS_FILE || path.join(os.homedir(), '.workbuddy/models.json');
update({ modelsFile });

function syncPublished(published = publishedModels()) {
  syncWrites = syncWrites.then(async () => {
    let sync;
    if (process.env.BUDDY_NO_SYNC === '1') sync = { skipped: true, count: published.length };
    else {
      try {
        if (!modelsFile) throw new Error('未找到有效的 WorkBuddy 配置，请点击导入并选择 models.json；首次使用请先在 WorkBuddy 保存一个自定义模型。');
        sync = await syncModels(modelsFile, published, `${endpoint}/chat/completions`, key, { allowEmpty: true, requireExisting: process.platform === 'win32' });
      }
      catch (e) { sync = { error: e.message }; }
    }
    update({ sync: { ...sync, time: new Date().toISOString() } });
    return sync;
  });
  return syncWrites;
}
async function record(model, ok, error, status, code, durationMs, source = 'request', chatOnly = source === 'request' && state.modelResults[model]?.chatOnly === true, meta = {}) {
  if (stopping) return;
  const result = withRequestMeta({ model, ...modelResult(ok, error, status, code), durationMs, source, chatOnly }, meta);
  // Keep the raw approval requests so a blocked native action stays diagnosable after the fact.
  const captured = Array.isArray(meta.permissions) && meta.permissions.length ? { lastPermission: { time: result.time, entries: meta.permissions } } : {};
  if (!ok && source === 'request' && ['invalid_model_output', 'invalid_tool_call', 'native_tool_activity', 'output_truncated'].includes(code)) {
    update({ lastRequest: result, ...captured });
    return;
  }
  if (ok) validated.add(model); else validated.delete(model);
  update({ lastRequest: result, ...(model ? { modelResults: { ...state.modelResults, [model]: result } } : {}), ...captured });
  update({ availableModels: usableModels().map(m => m.id) });
}
// In-flight visibility: a slow or retrying upstream currently produces no output at all, so
// the progress OpenCode reports on its event stream is published while the request runs.
const activities = new Map();
let activityTimer;
function publishActivity() {
  const now = Date.now();
  update({ activity: [...activities.values()].map(a => ({
    model: a.model, sessionID: a.sessionID, status: a.status || 'waiting',
    waitedMs: now - a.startedAt, sinceEventMs: a.lastEventAt ? now - a.lastEventAt : null,
    attempt: a.attempt, ...(a.error ? { error: a.error } : {}),
  })) });
}
function noteActivity(progress) {
  if (!progress?.sessionID) return;
  if (progress.type === 'request.done') { activities.delete(progress.sessionID); publishActivity(); return; }
  const entry = activities.get(progress.sessionID) || { sessionID: progress.sessionID, startedAt: Date.now(), status: 'waiting' };
  Object.assign(entry, progress, { model: progress.model || entry.model, lastEventAt: Date.now() });
  activities.set(progress.sessionID, entry);
  // Elapsed time must keep growing while the upstream stays quiet.
  if (!activityTimer) {
    activityTimer = setInterval(() => { if (activities.size) publishActivity(); else { clearInterval(activityTimer); activityTimer = null; } }, 5000);
    activityTimer.unref?.();
  }
  const urgent = progress.status === 'retry' || progress.status === 'permission' || progress.status === 'busy' || progress.error;
  const now = Date.now();
  if (!urgent && now - (entry.writtenAt || 0) < 1000) return;
  entry.writtenAt = now;
  publishActivity();
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
        const meta = {};
        const deadline = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; deadline.abort(); }, PROBE_TIMEOUT);
        try {
          if (model.toolcall === false) throw new BridgeError('OpenCode catalog does not advertise tool support', 502, 'invalid_tool_call');
          // A retry shares the single deadline, so detection time stays bounded.
          await probeModel({ complete: token => runtime.backend.complete(prepare(probeBody(model, token), models), AbortSignal.any([probeAbort.signal, deadline.signal]), meta) });
          await record(model.id, true, undefined, undefined, undefined, Math.round(performance.now() - started), 'probe', undefined, meta);
        } catch (cause) {
          const e = probeFailure(cause, timedOut);
          if (!stopping && e.code === 'no_action') {
            // Replying with text says the model works, not that it failed: it is usable for
            // chat only, so it is published with tools disabled instead of being withdrawn.
            await record(model.id, true, '探测时只返回文本、未产生动作；已按仅对话发布', undefined, 'chat_only', Math.round(performance.now() - started), 'probe', true);
          } else if (!stopping && formatUnsupported(e)) {
            try {
              const chatModel = { ...model, chatOnly: true };
              await runtime.backend.complete(prepare({ model: model.id, messages: [{ role: 'user', content: 'Reply only OK.' }] }, [chatModel]), AbortSignal.any([probeAbort.signal, AbortSignal.timeout(30000)]));
              await record(model.id, true, '工具转换不兼容：' + e.message, undefined, 'chat_only', Math.round(performance.now() - started), 'probe', true);
            } catch (chatError) {
              if (!stopping) await record(model.id, false, chatError.message, chatError.status, chatError.code, Math.round(performance.now() - started), 'probe');
            }
          } else if (!stopping) await record(model.id, false, e.name === 'TimeoutError' ? 'Model probe timed out' : e.message, e.status, e.code, Math.round(performance.now() - started), 'probe', undefined, meta);
        } finally { clearTimeout(timer); }
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

async function refresh(restartRuntime = false, useSystemProxy = state.useSystemProxy) {
  if (refreshing) return refreshing;
  if (probing || stopping) throw new Error('请等待检测完成');
  const proxyEnv = await systemProxyEnvironment(useSystemProxy);
  validated.clear();
  models = [];
  update({ phase: 'reading', message: '正在读取免费模型…', models: [], availableModels: [] });
  refreshing = (async () => {
    if (restartRuntime) {
      const next = await startBackend(binary, dataDir, log, proxyEnv);
      if (stopping) { await next.stop(); return; }
      const old = runtime;
      runtime = next;
      watchRuntime(next);
      await old?.stop();
      update({ useSystemProxy });
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
async function setSystemProxy(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('代理开关必须是布尔值');
  if (refreshing || probing || stopping) throw new Error('请等待读取和检测完成');
  await refresh(true, enabled);
  if (stopping) return;
  settings = { ...settings, useSystemProxy: enabled };
  await atomicWrite(settingsFile, JSON.stringify(settings));
  startProbes(undefined, true);
  return { useSystemProxy: enabled };
}
async function importModels(selectedFile) {
  if (stopping || probing || refreshing || state.phase !== 'ready') throw new Error('请等待读取和检测完成后导入');
  if (selectedFile !== undefined) {
    await validateModelsFile(selectedFile);
    if (modelsFile && modelsFile !== selectedFile && await fs.stat(modelsFile).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) {
      const cleanup = await syncPublished([]);
      if (cleanup.error) throw new Error(cleanup.error);
    }
    const nextSettings = { ...settings, workBuddyModelsFile: selectedFile };
    await atomicWrite(settingsFile, JSON.stringify(nextSettings));
    settings = nextSettings; modelsFile = selectedFile; update({ modelsFile });
  }
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
process.on('message', message => { if (message === 'shutdown') shutdown(); });
process.on('disconnect', () => shutdown());
process.on('SIGTERM', () => shutdown()); process.on('SIGINT', () => shutdown());
process.on('uncaughtException', e => { update({ phase: 'error', message: e.message }); shutdown(1); });
process.on('unhandledRejection', e => { update({ phase: 'error', message: String(e?.message || e) }); shutdown(1); });
try {
  update({ phase: 'starting' });
  await syncPublished([]);
  binary = await findRuntime(dataDir, message => update({ message }));
  server = createServer({ key, backend: { complete: (...args) => runtime.backend.complete(...args) }, getModels: publishedModels, refresh: readModels, importModels, setSystemProxy,
    status: () => state, probe: startProbes, onResult: record, onActivity: noteActivity });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  update({ message: '正在启动隔离模型服务' });
  runtime = await startBackend(binary, dataDir, log, await systemProxyEnvironment(state.useSystemProxy));
  watchRuntime(runtime);
  // Confirm this runtime has the dedicated agent, not a user's build agent.
  const agents = await runtime.backend.request('/agent');
  if (!agents.some(a => a.name === 'buddy-bridge')) throw new Error('Dedicated approval-gated agent missing');
  await refresh();
  startProbes(undefined, true, true);
  console.log(`Buddy Bridge ready at ${endpoint}; ${models.length} free models`);
} catch (e) { update({ phase: 'error', message: e.message }); if (!server?.listening) await shutdown(1); }
