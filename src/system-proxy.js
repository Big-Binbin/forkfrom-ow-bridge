import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export function parseSystemProxy(text) {
  const value = name => text.match(new RegExp(`^\\s*${name}\\s*:\\s*(.*?)\\s*$`, 'm'))?.[1];
  function address(kind) {
    if (value(`${kind}Enable`) !== '1') return undefined;
    const host = value(`${kind}Proxy`), port = Number(value(`${kind}Port`));
    if (!host || /[\s/@?#]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('系统代理地址无效');
    return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
  }
  const http = address('HTTP'), https = address('HTTPS');
  if (!https) throw new Error('请先在 macOS 中启用 HTTPS 系统代理；暂不支持仅 SOCKS 或 PAC 配置');
  return { HTTP_PROXY: http || https, HTTPS_PROXY: https,
    http_proxy: http || https, https_proxy: https,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' };
}
export async function systemProxyEnvironment(enabled) {
  if (!enabled) return { NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' };
  return parseSystemProxy((await exec('/usr/sbin/scutil', ['--proxy'], { timeout: 5000 })).stdout);
}
