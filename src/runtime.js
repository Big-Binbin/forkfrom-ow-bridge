import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { x as extract } from 'tar';
import { runtimePackage } from './platform.js';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { Backend, nativePermissions } from './backend.js';

const exec = promisify(execFile);
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export async function findRuntime(dataDir, updateStatus, options = {}) {
  const pkg = runtimePackage();
  const root = path.join(dataDir, 'runtime');
  const version = async file => (await exec(file, ['--version'], { timeout: 15000, windowsHide: true })).stdout.trim();
  // Reuse managed installations, including directories created by the formerly pinned installer.
  const installed = (await fs.readdir(root, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && VERSION.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }));
  for (const entry of installed) {
    const file = path.join(root, entry.name, pkg.binary);
    try { if (await version(file) === entry.name) return file; } catch {}
  }
  const candidates = options.candidates ?? [process.env.BUDDY_OPENCODE_PATH, path.join(os.homedir(), '.opencode', 'bin', pkg.binary), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode'].filter(Boolean);
  for (const file of candidates) {
    try {
      const found = await version(file);
      if (!VERSION.test(found)) continue;
      const target = path.join(root, found, pkg.binary);
      await fs.mkdir(path.dirname(target), { recursive: true });
      updateStatus('正在准备独立 OpenCode 运行时');
      await fs.copyFile(file, target + '.tmp'); await fs.chmod(target + '.tmp', 0o755);
      await fs.rename(target + '.tmp', target); return target;
    } catch {}
  }
  updateStatus('正在获取 OpenCode 官方当前版本');
  const packageName = pkg.name;
  const metaResponse = await fetch(`https://registry.npmjs.org/${packageName}/latest`, { signal: AbortSignal.timeout(30000) });
  if (!metaResponse.ok) throw new Error(`OpenCode 安装信息读取失败：HTTP ${metaResponse.status}`);
  const metadata = await metaResponse.json();
  const dist = metadata.dist;
  if (metadata.name !== packageName || !VERSION.test(metadata.version ?? '') || !dist?.integrity?.startsWith('sha512-') || !dist?.tarball?.startsWith(`https://registry.npmjs.org/${packageName}/-/`)) throw new Error('Unexpected official OpenCode package metadata');
  const target = path.join(root, metadata.version, pkg.binary);
  await fs.mkdir(path.dirname(target), { recursive: true });
  updateStatus(`正在下载 OpenCode ${metadata.version}，首次启动可能需要几分钟`);
  const archive = path.join(path.dirname(target), 'download.tgz');
  const download = await fetch(dist.tarball, { signal: AbortSignal.timeout(180000) });
  if (!download.ok || !download.body) throw new Error(`OpenCode 下载失败：HTTP ${download.status}`);
  await pipeline(Readable.fromWeb(download.body), createWriteStream(archive));
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (`sha512-${hash.digest('base64')}` !== dist.integrity) throw new Error('OpenCode download checksum mismatch');
  const member = `package/bin/${pkg.binary}`;
  const staging = await fs.mkdtemp(path.join(path.dirname(target), 'extract-'));
  try {
    await extract({ file: archive, cwd: staging, strip: 2, filter: (name, entry) => name === member && entry.type === 'File' });
    await fs.rename(path.join(staging, pkg.binary), target);
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
  await fs.chmod(target, 0o755);
  if (await version(target) !== metadata.version) throw new Error('Downloaded OpenCode version mismatch');
  await fs.unlink(archive);
  return target;
}

export const isolatedConfig = {
  permission: nativePermissions, autoupdate: false, share: 'disabled',
  agent: { 'buddy-chat': { mode: 'primary', description: 'Text-only external conversation', prompt: 'Reply in plain text to the external conversation. No tool use or local actions. Never claim to have executed an action.', permission: nativePermissions }, 'buddy-bridge': { mode: 'primary', description: 'External client inference only',
    prompt: 'You are the reasoning component of an external assistant. Never invoke native OpenCode tools. Describe external tool calls only in the requested JSON response. The external client owns execution and supplies tool results on the next request.',
    permission: nativePermissions } },
};

export async function startBackend(binary, dataDir, logStream, proxyEnv = {}) {
  const actualVersion = (await exec(binary, ['--version'], { timeout: 15000, windowsHide: true })).stdout.trim();
  const root = path.join(dataDir, 'opencode');
  for (const d of ['config', 'data', 'cache', 'state', 'project']) await fs.mkdir(path.join(root, d), { recursive: true, mode: 0o700 });
  // Preserve only normal OS/network settings, never other providers' keys or OpenCode auth overrides.
  const env = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC'])
    if (process.env[k]) env[k] = process.env[k];
  for (const name of ['config', 'data', 'cache', 'state']) env[`XDG_${name.toUpperCase()}_HOME`] = path.join(root, name);
  Object.assign(env, proxyEnv);
  const password = randomBytes(24).toString('hex');
  Object.assign(env, { OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(isolatedConfig) });
  // Refresh before starting the long-lived server so its first catalog is not the embedded stale snapshot.
  await exec(binary, ['models', 'opencode', '--refresh', '--pure'], { cwd: path.join(root, 'project'), env, windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  const port = await new Promise((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); });
  });
  const child = spawn(binary, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: path.join(root, 'project'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(logStream, { end: false }); child.stderr.pipe(logStream, { end: false });
  let failure; child.on('error', e => { failure = e; });
  const backend = new Backend(`http://127.0.0.1:${port}`, password, undefined, message => logStream.write(`${new Date().toISOString()} ${message}\n`));
  const stop = async () => {
    backend.stopEvents();
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 4000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  try {
    for (let i = 0; i < 120; i++) {
      if (failure || child.exitCode !== null) throw failure || new Error(`OpenCode exited: ${child.exitCode}`);
      try {
        const health = await backend.request('/global/health', 'GET', undefined, undefined, 1000);
        if (health.healthy) {
          if (health.version !== actualVersion) throw new Error('Unexpected OpenCode server version');
          return { backend, stop, child, version: health.version };
        }
      } catch (e) { if (e.message === 'Unexpected OpenCode server version') throw e; }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('OpenCode startup timed out');
  } catch (e) { await stop(); throw e; }
}
