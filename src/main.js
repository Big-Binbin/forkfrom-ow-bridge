import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveModelsFile, validateModelsFile } from './workbuddy-config.js';
import { searchConfig, windowsSearchRoots } from './config-finder.js';
import { dataDirectory } from './platform.js';
import { randomBytes } from 'node:crypto';
import { findRuntime, startBackend } from './runtime.js';
import { createServer } from './server.js';
import { systemProxyEnvironment } from './system-proxy.js';
import { prepare, BridgeError } from './protocol.js';
import { PROBE_TIMEOUT, probeBody, probeModel, probeFailure, formatUnsupported } from './probe.js';
import { modelResult, withRequestMeta } from './model-status.js';
import { atomicWrite } from './sync.js';
import { importIntoClient, removeFromClient, detectClients, createClients } from './import-service.js';

const dataDir = process.env.BUDDY_DATA_DIR || dataDirectory();
const port = Number(process.env.BUDDY_PORT || 41980);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid BUDDY_PORT');
await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
const lockFile = path.join(dataDir, 'service.pid');
try {
  const pid = Number(await fs.readFile(lockFile, 'utf8'));
  try { process.kill(pid, 0); console.error('OW Bridge is already running'); process.exit(2); }
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
let state = { useSystemProxy: settings.useSystemProxy === true || (process.platform === 'win32' && settings.useSystemProxy !== false), phase: 'starting', message: '正在启动', endpoint, pid: process.pid, version: '0.2.0', opencodeVersion: null, models: [], modelResults: previous.modelResults || {}, sync: null, availableModels: [], probe: { running: false } };
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
// Translation runs a second model whose only job is the shape. Detection never translates: a probe
// must measure the model itself, not what the translator can rescue.
const TRANSLATOR_ORDER = ['opencode/big-pickle', 'opencode/nemotron-3.5-lightning-free', 'opencode/space-bunny-free', 'opencode/mimo-v2.6-flash-free'];
const attachTranslator = runtime => {
  runtime.backend.translator = failed => {
    const usable = usableModels().map(model => model.id).filter(id => id !== failed);
    return TRANSLATOR_ORDER.find(id => usable.includes(id)) ?? usable[0] ?? null;
  };
  return runtime;
};
let syncWrites = Promise.resolve();
// Which clients this run publishes to. Stored in settings so a restart keeps the user's choice.
// An empty list means "nothing chosen yet" and nothing is written.
let targets = Array.isArray(settings.targets) ? settings.targets.filter(id => typeof id === 'string') : [];
let clients = createClients({ env: process.env, home: os.homedir() });
// Upgrading from a WorkBuddy-only build: an existing configuration that still carries this app's
// entries is cleaned up and refreshed exactly as before, so old models never linger pointing at a
// dead endpoint. A fresh install adopts WorkBuddy too, preserving the original one-click behaviour.
if (!targets.length) {
  const adopted = process.platform === 'win32'
    ? (await resolveModelsFile({ saved: settings.workBuddyModelsFile })
      ? ['workbuddy']
      : (await detectClients({ platform: 'win32' })).filter(c => c.installed && c.auto).map(c => c.id))
    : ['workbuddy'];
  targets = adopted;
}
update({ clients: await detectClients(), targets });

// WorkBuddy can keep its models.json outside the default location, so its adapter takes the
// remembered path instead of the computed one. The other clients have a fixed location.
let modelsFile = process.platform === 'win32'
  ? await resolveModelsFile({ saved: settings.workBuddyModelsFile })
  : process.env.BUDDY_MODELS_FILE || path.join(os.homedir(), '.workbuddy/models.json');
update({ modelsFile });

// Resolve one client id to its descriptor, refusing unknown ids rather than guessing.
// WorkBuddy's target may be a remembered location, so it overrides the computed path.
function clientById(id) {
  const client = clients.find(c => c.id === id);
  if (!client) throw new Error(`未知的目标客户端：${id}`);
  return client.id === 'workbuddy' && modelsFile ? { ...client, locate: () => modelsFile } : client;
}

// Each client expects the endpoint in its own shape: WorkBuddy and the Trae family want the
// full completions path, while ZCode and DeepSeek Harness take a bare base URL and append the
// route themselves. Sending the full path to the latter produces a doubled route.
const fullPath = client => client.kind === 'vscdb' || client.id === 'workbuddy';
function endpointFor(client) {
  return fullPath(client) ? `${endpoint}/chat/completions` : endpoint;
}

// Publish (or clear, when the model list is empty) the given models into every chosen client.
// Failures are collected per client so one bad target cannot block the others.
function syncPublished(published = publishedModels()) {
  syncWrites = syncWrites.then(async () => {
    let results = [];
    if (process.env.BUDDY_NO_SYNC === '1') results = [{ skipped: true, count: published.length }];
    else {
      for (const id of targets) {
        try {
          const client = clientById(id);
          results.push(published.length
            ? await importIntoClient(client, published, endpointFor(client), key)
            : await removeFromClient(client, published, endpointFor(client), key));
        }
        catch (e) { results.push({ id, label: id, error: e.message }); }
      }
      if (targets.length && !published.length) results = results.filter(r => r.changed !== false || r.count);
    }
    update({ sync: { results, time: new Date().toISOString() } });
    return results;
  });
  return syncWrites;
}
async function record(model, ok, error, status, code, durationMs, source = 'request', chatOnly = source === 'request' && state.modelResults[model]?.chatOnly === true, meta = {}) {
  if (stopping) return;
  const result = withRequestMeta({ model, ...modelResult(ok, error, status, code), durationMs, source, chatOnly }, meta);
  // Keep the raw approval requests so a blocked native action stays diagnosable after the fact.
  const captured = Array.isArray(meta.permissions) && meta.permissions.length ? { lastPermission: { time: result.time, entries: meta.permissions } } : {};
  // A stuck provider is not a verdict on the model: record the attempt, keep it published.
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
    sinceContentMs: a.lastContentAt ? now - a.lastContentAt : null, repairModel: a.repairModel,
    attempt: a.attempt, ...(a.error ? { error: a.error } : {}),
  })) });
}
function noteActivity(progress) {
  if (!progress?.sessionID) return;
  if (progress.type === 'request.done') { activities.delete(progress.sessionID); publishActivity(); return; }
  const entry = activities.get(progress.sessionID) || { sessionID: progress.sessionID, startedAt: Date.now(), status: 'waiting' };
  Object.assign(entry, progress, { model: progress.model || entry.model, lastEventAt: Date.now() });
  if (progress.content) entry.lastContentAt = Date.now();
  activities.set(progress.sessionID, entry);
  // Elapsed time must keep growing while the upstream stays quiet.
  if (!activityTimer) {
    activityTimer = setInterval(() => { if (activities.size) publishActivity(); else { clearInterval(activityTimer); activityTimer = null; } }, 5000);
    activityTimer.unref?.();
  }
  const urgent = progress.type === 'bridge.phase' || progress.status === 'retry' || progress.status === 'permission' || progress.error;
  const now = Date.now();
  if (!urgent && now - (entry.writtenAt || 0) < 1000) return;
  entry.writtenAt = now;
  publishActivity();
}
let probing = false, probeTask;
const probeAbort = new AbortController();
function startProbes(modelID, reveal = false, autoImport = false) {
  if (stopping || refreshing || configSearch) throw new Error('请等待模型读取或配置查找完成');
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
        const meta = { probe: true };
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
      // A first run adopts the default WorkBuddy config only when WorkBuddy is actually a
      // target; the other clients are located automatically and need no search.
      if (autoImport && !stopping) {
        if (process.platform === 'win32' && targets.includes('workbuddy') && !modelsFile && process.env.BUDDY_NO_SYNC !== '1') {
          const found = await findConfig(true);
          if (found.candidates.length) {
            await validateModelsFile(found.candidates[0]);
            settings = { ...settings, workBuddyModelsFile: found.candidates[0] };
            await atomicWrite(settingsFile, JSON.stringify(settings));
            modelsFile = found.candidates[0]; update({ modelsFile });
          }
        }
        if (targets.length) await syncPublished();
      }
    } finally { probing = false; update({ probe: { running: false } }); }
  })().catch(e => console.error('Model detection failed:', e.message));
  return { started: true };
}

function watchRuntime(current) {
  update({ opencodeVersion: current.version });
  current.child.on('exit', () => {
    if (!stopping && runtime === current) {
      update({ phase: 'error', message: 'OpenCode 服务退出，请重启代理' });
      shutdown(1);
    }
  });
}

async function refresh(restartRuntime = false, useSystemProxy = state.useSystemProxy) {
  if (refreshing) return refreshing;
  if (probing || stopping || configSearch) throw new Error('请等待检测或配置查找完成');
  const proxyEnv = await systemProxyEnvironment(useSystemProxy);
  validated.clear();
  models = [];
  update({ phase: 'reading', message: '正在读取免费模型…', models: [], availableModels: [] });
  refreshing = (async () => {
    if (restartRuntime) {
      const next = attachTranslator(await startBackend(binary, dataDir, log, proxyEnv));
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
  if (refreshing || probing || stopping || configSearch) throw new Error('请等待读取和检测完成');
  await refresh(true, enabled);
  if (stopping) return;
  settings = { ...settings, useSystemProxy: enabled };
  await atomicWrite(settingsFile, JSON.stringify(settings));
  startProbes(undefined, true);
  return { useSystemProxy: enabled };
}
let configSearch;
// WorkBuddy can keep its config outside the standard location, so it keeps the model-assisted
// search: OpenCode looks for models.json with read-only tools and this app validates the result.
async function findConfig(afterProbe = false) {
  if (process.platform !== 'win32') throw new Error('自动查找仅用于 Windows');
  if (stopping || refreshing || !runtime || (probing && !afterProbe)) throw new Error('请等待服务就绪');
  if (configSearch) return configSearch;
  configSearch = (async () => {
    update({ configSearch: { running: true }, message: 'OpenCode 正在只读查找 WorkBuddy 配置…' });
    try {
      const result = await searchConfig(runtime.backend, usableModels(), await windowsSearchRoots(os.homedir()), probeAbort.signal);
      if (!stopping) update({ configSearch: { running: false, ...result }, message: '运行中' });
      return result;
    } catch (error) {
      if (!stopping) update({ configSearch: { running: false, candidates: [], errors: [error.message] } });
      throw error;
    }
  })();
  try { return await configSearch; } finally { configSearch = null; }
}

// Import into the chosen clients. Passing an explicit list replaces the saved selection, which
// first withdraws this app's entries from the clients that are no longer selected.
async function importModels(payload) {
  const selected = payload?.targets;
  const chosenFile = payload?.modelsFile;
  if (stopping || probing || refreshing || configSearch || state.phase !== 'ready') throw new Error('请等待读取和检测完成后导入');
  // WorkBuddy 的 models.json 可被用户指定到其它位置。切换前先用旧路径清理本应用条目，
  // 否则这些条目会继续指向即将消失的接口；清理完成后才切换到新路径并写入。
  if (chosenFile !== undefined && chosenFile !== modelsFile) {
    await validateModelsFile(chosenFile);
    if (modelsFile && await fs.stat(modelsFile).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) {
      const cleanup = await syncPublished([]);
      const failed = cleanup.filter(r => r.error);
      if (failed.length) throw new Error(`清理原配置失败：${failed.map(r => `${r.label}：${r.error}`).join('；')}`);
    }
    settings = { ...settings, workBuddyModelsFile: chosenFile };
    await atomicWrite(settingsFile, JSON.stringify(settings));
    modelsFile = chosenFile; update({ modelsFile });
  }
  if (selected !== undefined) {
    if (!Array.isArray(selected) || selected.some(id => typeof id !== 'string')) throw new Error('目标客户端列表格式不正确');
    const next = [...new Set(selected)];
    for (const id of next) clientById(id);
    // Deselecting a client must remove the entries this app put there, or they would keep
    // pointing at an endpoint that is about to disappear.
    const dropped = targets.filter(id => !next.includes(id));
    if (dropped.length) {
      const cleanup = await syncPublished([]);
      if (cleanup.some(r => r.error)) {
        const failed = cleanup.filter(r => r.error).map(r => `${r.label}：${r.error}`).join('；');
        throw new Error(`清理原目标失败：${failed}`);
      }
    }
    targets = next;
    settings = { ...settings, targets };
    await atomicWrite(settingsFile, JSON.stringify(settings));
    update({ targets });
  }
  if (!targets.length) throw new Error('请先选择要导入的客户端');
  const results = await syncPublished();
  const failed = results.filter(r => r.error);
  if (failed.length) throw new Error(failed.map(r => `${r.label}：${r.error}`).join('；'));
  return { results, targets, apiKey: key, endpoint: `${endpoint}/chat/completions` };
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
  let startupProxyEnv;
  try { startupProxyEnv = await systemProxyEnvironment(state.useSystemProxy); }
  catch (error) {
    // A fresh install prefers the system proxy when one exists, but a machine without a manual
    // proxy must still be able to download directly. An explicitly saved "on" setting remains strict.
    if (settings.useSystemProxy === true) throw error;
    startupProxyEnv = await systemProxyEnvironment(false);
    update({ useSystemProxy: false });
    log.write(`${new Date().toISOString()} 未检测到可用的系统代理，首次下载改为直连：${error.message}\n`);
  }
  binary = await findRuntime(dataDir, message => update({ message }), {
    proxyEnv: startupProxyEnv,
    onProxyFallback: async () => {
      if (settings.useSystemProxy !== true) {
        startupProxyEnv = await systemProxyEnvironment(false);
        update({ useSystemProxy: false });
      }
    },
    log: message => log.write(`${new Date().toISOString()} ${message}\n`),
  });
  server = createServer({ key, backend: { complete: (...args) => runtime.backend.complete(...args) }, getModels: publishedModels, refresh: readModels, importModels, findConfig, setSystemProxy,
    status: () => state, probe: startProbes, onResult: record, onActivity: noteActivity });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  update({ message: '正在启动隔离模型服务' });
  runtime = attachTranslator(await startBackend(binary, dataDir, log, startupProxyEnv));
  watchRuntime(runtime);
  // Confirm this runtime has the dedicated agent, not a user's build agent.
  const agents = await runtime.backend.request('/agent');
  if (!agents.some(a => a.name === 'buddy-bridge')) throw new Error('Dedicated approval-gated agent missing');
  await refresh();
  startProbes(undefined, true, true);
  console.log(`OW Bridge ready at ${endpoint}; ${models.length} free models`);
} catch (e) { update({ phase: 'error', message: e.message }); if (!server?.listening) await shutdown(1); }
