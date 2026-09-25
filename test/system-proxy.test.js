import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSystemProxy, systemProxyEnvironment } from '../src/system-proxy.js';
test('system proxy maps HTTP and HTTPS and bypasses local services', () => {
  const env = parseSystemProxy('HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7892\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7892');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7892');
  assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY);
  assert.equal(env.https_proxy, env.HTTPS_PROXY);
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
});
test('off does not inherit proxy; unsupported or invalid system config fails explicitly', async () => {
  assert.equal((await systemProxyEnvironment(false)).HTTPS_PROXY, undefined);
  assert.throws(() => parseSystemProxy('SOCKSEnable : 1'), /HTTPS/);
  assert.throws(() => parseSystemProxy('HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 99999'), /无效/);
});
