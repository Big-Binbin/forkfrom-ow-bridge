import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { Backend, nativePermissions } from './backend.js';

const exec = promisify(execFile);
export const PINNED_VERSION = '1.18.32';

export async function findRuntime(dataDir, updateStatus, options = {}) {
  const target = path.join(dataDir, 'runtime', PINNED_VERSION, 'opencode');
  const version = async file => (await exec(file, ['--version'], { timeout: 15000 })).stdout.trim();
  try { if (await version(target) === PINNED_VERSION) return target; } catch {}
  await fs.mkdir(path.dirname(target), { recursive: true });
  const candidates = options.candidates ?? [process.env.BUDDY_OPENCODE_PATH, path.join(os.homedir(), '.opencode/bin/opencode'), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode'].filter(Boolean);
  for (const file of candidates) {
    try {
      if (await version(file) !== PINNED_VERSION) continue;
      updateStatus('正在准备独立 OpenCode 运行时');
      await fs.copyFile(file, target + '.tmp'); await fs.chmod(target + '.tmp', 0o755);
      await fs.rename(target + '.tmp', target); return target;
    } catch {}
  }
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('Automatic installation currently supports macOS arm64/x64');
  updateStatus(`正在下载 OpenCode ${PINNED_VERSION}，首次启动可能需要几分钟`);
  const packageName = `opencode-darwin-${process.arch}`;
  const metadata = JSON.parse((await exec('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--http1.1', '--max-time', '30', `https://registry.npmjs.org/${packageName}/${PINNED_VERSION}`], { maxBuffer: 4 * 1024 * 1024 })).stdout);
  const dist = metadata.dist;
  if (metadata.name !== packageName || metadata.version !== PINNED_VERSION || !dist?.integrity?.startsWith('sha512-') || !dist.tarball.startsWith(`https://registry.npmjs.org/${packageName}/-/`)) throw new Error('Unexpected official OpenCode package metadata');
  const archive = path.join(path.dirname(target), 'download.tgz');
  await exec('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--http1.1', '--retry', '2', '--max-time', '180', '--output', archive, dist.tarball], { maxBuffer: 1024 * 1024 });
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (`sha512-${hash.digest('base64')}` !== dist.integrity) throw new Error('OpenCode download checksum mismatch');
  const names = (await exec('/usr/bin/tar', ['-tzf', archive])).stdout.trim().split('\n');
  if (names.some(n => n.startsWith('/') || n.split('/').includes('..')) || !names.includes('package/bin/opencode')) throw new Error('Unexpected OpenCode archive structure');
  await exec('/usr/bin/tar', ['-xzf', archive, '-C', path.dirname(target), '--strip-components', '2', 'package/bin/opencode']);
  await fs.chmod(target, 0o755);
  if (await version(target) !== PINNED_VERSION) throw new Error('Downloaded OpenCode version mismatch');
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
  const root = path.join(dataDir, 'opencode');
  for (const d of ['config', 'data', 'cache', 'state', 'project']) await fs.mkdir(path.join(root, d), { recursive: true, mode: 0o700 });
  // Preserve only normal OS/network settings, never other providers' keys or OpenCode auth overrides.
  const env = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'])
    if (process.env[k]) env[k] = process.env[k];
  for (const name of ['config', 'data', 'cache', 'state']) env[`XDG_${name.toUpperCase()}_HOME`] = path.join(root, name);
  Object.assign(env, proxyEnv);
  const password = randomBytes(24).toString('hex');
  Object.assign(env, { OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(isolatedConfig) });
  // Refresh before starting the long-lived server so its first catalog is not the embedded stale snapshot.
  await exec(binary, ['models', 'opencode', '--refresh', '--pure'], { cwd: path.join(root, 'project'), env, timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
  const port = await new Promise((resolve, reject) => {
    const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => resolve(n)); });
  });
  const child = spawn(binary, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: path.join(root, 'project'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(logStream, { end: false }); child.stderr.pipe(logStream, { end: false });
  let failure; child.on('error', e => { failure = e; });
  const backend = new Backend(`http://127.0.0.1:${port}`, password);
  const stop = async () => {
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
          if (health.version !== PINNED_VERSION) throw new Error('Unexpected OpenCode server version');
          return { backend, stop, child };
        }
      } catch (e) { if (e.message === 'Unexpected OpenCode server version') throw e; }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('OpenCode startup timed out');
  } catch (e) { await stop(); throw e; }
}
