import os from 'node:os';
import path from 'node:path';

export function dataDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'Buddy Bridge');
  if (platform === 'win32') return p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'Buddy Bridge');
  return p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'Buddy Bridge');
}

export function runtimePackage(platform = process.platform, arch = process.arch) {
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch))
    throw new Error(`不支持的系统或架构：${platform}/${arch}`);
  return { name: `opencode-${platform === 'win32' ? 'windows' : platform}-${arch}`, binary: platform === 'win32' ? 'opencode.exe' : 'opencode' };
}
