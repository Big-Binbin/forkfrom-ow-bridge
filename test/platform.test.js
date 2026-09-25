import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dataDirectory, runtimePackage } from '../src/platform.js';
import { parseWindowsProxy } from '../src/system-proxy.js';

test('platform paths preserve macOS data and locate Windows and Linux data', () => {
  assert.equal(dataDirectory('darwin', {}, '/Users/test'), '/Users/test/Library/Application Support/Buddy Bridge');
  assert.equal(dataDirectory('win32', { APPDATA: 'C:\\Users\\测试\\AppData\\Roaming' }, 'C:\\Users\\测试'), 'C:\\Users\\测试\\AppData\\Roaming\\Buddy Bridge');
  assert.equal(dataDirectory('win32', {}, 'C:\\Users\\Test'), 'C:\\Users\\Test\\AppData\\Roaming\\Buddy Bridge');
  assert.equal(dataDirectory('linux', { XDG_CONFIG_HOME: '/tmp/config' }, '/home/test'), '/tmp/config/Buddy Bridge');
  assert.deepEqual(runtimePackage('win32', 'x64'), { name: 'opencode-windows-x64', binary: 'opencode.exe' });
  assert.equal(runtimePackage('win32', 'arm64').name, 'opencode-windows-arm64');
  assert.equal(runtimePackage('darwin', 'arm64').binary, 'opencode');
  assert.throws(() => runtimePackage('win32', 'ia32'), /不支持/);
});
test('Windows manual proxy accepts shared and per-protocol addresses', () => {
  const shared = parseWindowsProxy({ ProxyEnable: 1, ProxyServer: '127.0.0.1:7890' });
  assert.equal(shared.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(parseWindowsProxy({ ProxyEnable: 1, ProxyServer: 'localhost:80' }).HTTPS_PROXY, 'http://localhost');
  assert.equal(shared.no_proxy, 'localhost,127.0.0.1,::1');
  const split = parseWindowsProxy({ ProxyEnable: 1, ProxyServer: 'http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892' });
  assert.equal(split.HTTP_PROXY, 'http://127.0.0.1:7890');
  assert.equal(split.HTTPS_PROXY, 'http://127.0.0.1:7891');
  for (const settings of [{ ProxyEnable: 0 }, { ProxyEnable: 1, ProxyServer: 'socks=localhost:7890' }, { ProxyEnable: 1, ProxyServer: 'localhost:99999' }]) assert.throws(() => parseWindowsProxy(settings));
});
