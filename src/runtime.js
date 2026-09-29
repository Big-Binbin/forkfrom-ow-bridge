import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { x as extract } from 'tar';
import { runtimePackage } from './platform.js';
import { replaceWithRetry } from './atomic.js';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { Backend, nativePermissions } from './backend.js';

const exec = promisify(execFile);
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function compareVersions(a, b) {
  const left = a.split(/[+-]/, 1)[0].split('.').map(Number);
  const right = b.split(/[+-]/, 1)[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

// Where an existing OpenCode installation is looked up. macOS installs it under ~/.opencode, and
// so does Windows; a Windows user may also have installed it globally from npm, whose launcher is
// a .cmd shim wrapping the real executable under the npm prefix.
export function runtimeCandidates(pkg = runtimePackage(), platform = process.platform, env = process.env, home = os.homedir()) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const installed = platform === 'win32'
    ? [p.join(home, '.opencode', 'bin', pkg.binary),
       p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'npm', 'node_modules', 'opencode-ai', 'bin', pkg.binary)]
    : [p.join(home, '.opencode', 'bin', pkg.binary), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode'];
  return [env.BUDDY_OPENCODE_PATH, ...installed].filter(Boolean);
}

export async function findRuntime(dataDir, updateStatus, options = {}) {
  const pkg = runtimePackage();
  const root = path.join(dataDir, 'runtime');
  const log = options.log ?? (() => {});
  const version = options.probe ?? (async file => (await exec(file, ['--version'], { timeout: 15000, windowsHide: true })).stdout.trim());
  const readLatest = options.latest ?? (async () => {
    updateStatus('Checking official OpenCode version');
    const metaResponse = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, { signal: AbortSignal.timeout(30000) });
    if (!metaResponse.ok) throw new Error(`OpenCode package metadata failed: HTTP ${metaResponse.status}`);
    const metadata = await metaResponse.json();
    const dist = metadata.dist;
    if (metadata.name !== pkg.name || !VERSION.test(metadata.version ?? '') || !dist?.integrity?.startsWith('sha512-') || !dist?.tarball?.startsWith(`https://registry.npmjs.org/${pkg.name}/-/`)) throw new Error('Unexpected official OpenCode package metadata');
    return metadata;
  });
  const installLatest = async metadata => {
    const target = path.join(root, metadata.version, pkg.binary);
    if (await version(target).then(found => found === metadata.version, () => false)) return target;
    await fs.mkdir(path.dirname(target), { recursive: true });
    updateStatus(`Downloading OpenCode ${metadata.version}; first launch may take a few minutes`);
    const archive = path.join(path.dirname(target), 'download.tgz');
    const download = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(180000) });
    if (!download.ok || !download.body) throw new Error(`OpenCode download failed: HTTP ${download.status}`);
    await pipeline(Readable.fromWeb(download.body), createWriteStream(archive));
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    if (`sha512-${hash.digest('base64')}` !== metadata.dist.integrity) throw new Error('OpenCode download checksum mismatch');
    const member = `package/bin/${pkg.binary}`;
    const staging = await fs.mkdtemp(path.join(path.dirname(target), 'extract-'));
    try {
      await extract({ file: archive, cwd: staging, strip: 2, filter: (name, entry) => name === member && entry.type === 'File' });
      await replaceWithRetry(path.join(staging, pkg.binary), target);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
    await fs.chmod(target, 0o755);
    if (await version(target) !== metadata.version) throw new Error('Downloaded OpenCode version mismatch');
    await fs.unlink(archive).catch(() => {});
    return target;
  };
  const local = [];
  // Reuse managed installations, including directories created by the formerly pinned installer.
  const installed = (await fs.readdir(root, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && VERSION.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name, 'en', { numeric: true }));
  for (const entry of installed) {
    const file = path.join(root, entry.name, pkg.binary);
    try { if (await version(file) === entry.name) local.push({ file, version: entry.name, source: 'managed runtime' }); } catch {}
  }
  const candidates = options.candidates ?? runtimeCandidates(pkg);
  const rejected = [];
  for (const file of candidates) {
    // A launcher shim cannot become the runtime: Windows cannot execute a .cmd without a shell,
    // and copying it in place of opencode.exe would install something that is not an executable.
    if (/\.(?:cmd|bat|ps1)$/i.test(file)) { rejected.push(`${file}: launcher script cannot be used as the runtime binary`); continue; }
    try {
      const found = await version(file);
      if (!VERSION.test(found)) { rejected.push(`${file}: unrecognized version output (${found || 'empty'})`); continue; }
      const target = path.join(root, found, pkg.binary);
      // Never rewrite a binary that already reports this version. Windows cannot replace a running
      // image, so re-copying would fail for nothing whenever this runtime is already in use.
      if (await version(target).then(found2 => found2 === found, () => false)) { local.push({ file: target, version: found, source: 'managed runtime' }); continue; }
      await fs.mkdir(path.dirname(target), { recursive: true });
      updateStatus('Preparing isolated OpenCode runtime');
      const temp = target + '.tmp';
      try { await fs.copyFile(file, temp); await fs.chmod(temp, 0o755); await replaceWithRetry(temp, target); }
      finally { await fs.unlink(temp).catch(() => {}); }
      local.push({ file: target, version: found, source: file });
    } catch (e) { rejected.push(`${file}: ${e.code || e.message}`); }
  }
  local.sort((a, b) => compareVersions(b.version, a.version));
  const best = local[0];
  let metadata;
  try { metadata = await readLatest(); }
  catch (e) {
    if (best) { log(`Could not check official OpenCode latest (${e.message}); using local ${best.version}: ${best.file}`); return best.file; }
    if (rejected.length) log(`Local OpenCode candidates were rejected (${rejected.join('; ')})`);
    throw e;
  }
  if (best && compareVersions(best.version, metadata.version) >= 0) {
    log(`Using ${best.source} OpenCode ${best.version}: ${best.file}`);
    return best.file;
  }
  if (best) log(`Local OpenCode ${best.version} is older than official ${metadata.version}; downloading official runtime`);
  else log(rejected.length ? `Local OpenCode candidates were rejected (${rejected.join('; ')}); downloading official runtime` : 'No local OpenCode runtime found; downloading official runtime');
  return await installLatest(metadata);
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
