// 多客户端导入的单元测试：覆盖 ZCode provider 合并、WorkBuddy 兼容行为、
// DeepSeek Harness 的 YAML provider 与凭据、Trae 系 vscdb 写入与清理，以及客户端探测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import yaml from 'js-yaml';
import { createClients, OWNER, ZCODE_PROVIDER_ID, TRAE_GROUPS, traeEntry, zcodeMerge } from '../src/clients.js';
import { importIntoClient, removeFromClient, detectClients } from '../src/import-service.js';
import { parsePatch, dshProviderEntry } from '../src/dsh-config.js';

const MODELS = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
// 客户端发出的 model 字段是带前缀的显示名，导入必须使用同一个 id
const IDS = ['OC · A', 'OC · B'];

function readGroups(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  // 直接按键取，避免依赖 LIKE 匹配；键名与写入层一致
  const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('7_AI.agent.model.model_list_map');
  const other = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('unrelated');
  db.close();
  return { doc: JSON.parse(String(row.value)), other: JSON.parse(String(other.value)) };
}

test('ZCode 导入只改本应用的 provider，其余 provider 内容零改动，且清理后完全还原', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-zcode-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'provider_config.json');
  const before = {
    schemaVersion: 1,
    config: {
      providerOrder: ['keep-1', 'keep-2'],
      providerConfigRules: { providerRules: [
        { providerId: 'keep-1', providerName: 'A', config: { access: { apiKey: 'secret-1' } } },
        { providerId: 'keep-2', providerName: 'B', config: { access: { apiKey: 'secret-2' } } },
      ] },
      modelConfigRules: { providerModelRules: [{ modelId: 'm1', providerId: 'keep-1', config: { enabled: true } }], manualProviderModelRules: [] },
    },
  };
  await fs.writeFile(file, JSON.stringify(before, null, 2));
  const zcode = { ...createClients({ home: root, platform: 'win32' }).find(c => c.id === 'zcode'), locate: () => file };

  const result = await importIntoClient(zcode, MODELS, 'http://127.0.0.1:41980/v1', 'bridge-key');
  assert.equal(result.changed, true);
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  // 本应用的 provider 被追加，且排在原有 provider 之后
  assert.deepEqual(after.config.providerOrder, ['keep-1', 'keep-2', ZCODE_PROVIDER_ID]);
  const rule = after.config.providerConfigRules.providerRules.find(r => r.providerId === ZCODE_PROVIDER_ID);
  assert.equal(rule.config.access.apiKey, 'bridge-key');
  assert.equal(rule.config.api.baseUrl, 'http://127.0.0.1:41980/v1');
  assert.equal(rule.config.api.type, 'openai-chat-completions');
  assert.deepEqual(rule.config.personalModelIds, IDS);
  // 原有 provider 逐字节不变
  for (const original of before.config.providerConfigRules.providerRules) {
    assert.deepEqual(after.config.providerConfigRules.providerRules.find(r => r.providerId === original.providerId), original);
  }
  // 原有 model 规则不变，本应用的规则追加在后面
  assert.deepEqual(after.config.modelConfigRules.providerModelRules[0], before.config.modelConfigRules.providerModelRules[0]);
  assert.deepEqual(after.config.modelConfigRules.providerModelRules.slice(1).map(r => r.modelId), IDS);
  assert.deepEqual(after.config.modelConfigRules.manualProviderModelRules, []);

  // 重复导入不产生任何写入
  assert.equal((await importIntoClient(zcode, MODELS, 'http://127.0.0.1:41980/v1', 'bridge-key')).changed, false);

  // 清理后与导入前完全一致
  await removeFromClient(zcode, MODELS, 'http://127.0.0.1:41980/v1', 'bridge-key');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), before);
});

test('ZCode 配置格式无法识别时拒绝写入，不破坏原文件', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-zcode-bad-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'provider_config.json');
  const original = '{"unexpected":true}';
  await fs.writeFile(file, original);
  const zcode = { ...createClients({ home: root, platform: 'win32' }).find(c => c.id === 'zcode'), locate: () => file };
  await assert.rejects(importIntoClient(zcode, MODELS, 'e', 'k'), /无法识别/);
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('WorkBuddy 保留用户自有模型与 availableModels 同步', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-wb-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'models.json');
  await fs.writeFile(file, JSON.stringify({
    models: [{ id: 'mine', url: 'u', apiKey: 'k' }, { id: 'old', buddyBridgeOwner: OWNER }],
    availableModels: ['mine', 'old'],
  }));
  const workbuddy = { ...createClients({ home: root, platform: 'win32' }).find(c => c.id === 'workbuddy'), locate: () => file };
  await importIntoClient(workbuddy, MODELS, 'http://127.0.0.1:41980/v1', 'k');
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(after.models.map(m => m.id), ['mine', ...IDS], '用户模型在前，本应用条目在后');
  assert.deepEqual(after.availableModels, ['mine', ...IDS], '旧的 owned 条目从可用列表中移除');
  await removeFromClient(workbuddy, MODELS, 'http://127.0.0.1:41980/v1', 'k');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).models.map(m => m.id), ['mine']);
});

test('Trae 系写入覆盖全部 Agent 分组，幂等，且不碰用户自有自定义模型', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-trae-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.vscdb');
  // 预置一条用户自己的自定义模型，导入后必须原样保留（含其加密密钥）
  const db = new DatabaseSync(file);
  const own = { name: 'custom_openai_compatible//mine', ak: 'USER-ENCRYPTED-KEY', config_source: 3 };
  const document = Object.fromEntries(TRAE_GROUPS.map(g => [g, [own]]));
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('7_AI.agent.model.model_list_map', JSON.stringify(document));
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('unrelated', JSON.stringify({ keep: true }));
  db.close();

  const client = { ...createClients({ env: { APPDATA: root }, home: root, platform: 'win32' }).find(c => c.id === 'traecodecn'), locate: () => file };
  const result = await importIntoClient(client, MODELS, 'http://127.0.0.1:41980/v1', 'secret');
  assert.equal(result.changed, true);
  assert.equal(result.needsKey, true, '密钥不可代写，必须提示用户手动补填');

  const { doc, other } = readGroups(file);
  for (const group of TRAE_GROUPS) {
    const ours = doc[group].filter(m => m.name === `custom_openai_compatible//${IDS[0]}`);
    assert.equal(ours.length, 1, `${group} 中本应用条目有且仅有一份`);
    assert.equal(ours[0].ak, null, '密钥留空，等待用户在客户端内填写');
    assert.equal(ours[0].base_url, 'http://127.0.0.1:41980/v1/chat/completions');
    assert.equal(ours[0].custom_model_id.length, 10);
    // 用户自己的条目必须还在，且密钥未被改动
    assert.equal(doc[group].filter(m => m.name === own.name).length, 1);
    assert.equal(doc[group].find(m => m.name === own.name).ak, 'USER-ENCRYPTED-KEY');
  }
  assert.deepEqual(other, { keep: true }, '同一库中的其它表项不受影响');

  // 重复导入不产生写入
  assert.equal((await importIntoClient(client, MODELS, 'http://127.0.0.1:41980/v1', 'secret')).changed, false);

  // 清理只移除本应用条目
  await removeFromClient(client, MODELS, 'http://127.0.0.1:41980/v1', 'secret');
  const cleaned = readGroups(file).doc;
  for (const group of TRAE_GROUPS) {
    assert.deepEqual(cleaned[group].map(m => m.name), [own.name], '清理后只剩用户自己的条目');
  }
});

test('Trae 数据库不存在模型配置时明确报错', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-trae-empty-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.vscdb');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  db.close();
  const client = { ...createClients({ env: { APPDATA: root }, home: root, platform: 'win32' }).find(c => c.id === 'traecodecn'), locate: () => file };
  await assert.rejects(importIntoClient(client, MODELS, 'e', 'k'), /未在该客户端中找到模型配置/);
});

test('客户端探测报告安装状态，Trae 系标记为需手动补填', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-detect-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.zcode', 'v2'), { recursive: true });
  await fs.writeFile(path.join(root, '.zcode', 'v2', 'provider_config.json'), '{"config":{}}');
  const list = await detectClients({ env: { APPDATA: path.join(root, 'appdata') }, home: root, platform: 'win32' });
  const byId = Object.fromEntries(list.map(c => [c.id, c]));
  assert.equal(byId.zcode.installed, true);
  assert.equal(byId.zcode.auto, true);
  assert.equal(byId.workbuddy.installed, false);
  assert.equal(byId.traecodecn.installed, false);
  assert.equal(byId.traecodecn.auto, false, 'Trae 系无法全自动导入');
  assert.match(byId.qoder.note, /API Key/);
  // 全部 7 个目标都在，且 Trae 系五个客户端齐备
  for (const id of ['workbuddy', 'zcode', 'traecodecn', 'traecode', 'traeworkcn', 'qodercn', 'qoder']) assert.ok(byId[id], `缺少客户端 ${id}`);
});

test('未安装的客户端探测路径不存在的 APPDATA 时返回 null', async () => {
  const list = createClients({ env: {}, home: 'C:\\none', platform: 'win32' });
  assert.equal(list.find(c => c.id === 'traecodecn').locate({ env: {} }), null);
  assert.ok(list.find(c => c.id === 'workbuddy').locate({ env: {} }));
});

test('macOS 仅保留 WorkBuddy，Windows 提供全部八个目标', () => {
  assert.deepEqual(createClients({ home: '/h', platform: 'darwin' }).map(c => c.id), ['workbuddy']);
  assert.deepEqual(createClients({ home: 'C:\\h', platform: 'win32' }).map(c => c.id),
    ['workbuddy', 'zcode', 'dsh', 'traecodecn', 'traecode', 'traeworkcn', 'qodercn', 'qoder']);
});
// DeepSeek Harness 用纯 YAML 描述 provider，且密钥走环境变量引用，可全自动导入。
test('DeepSeek Harness 写入 provider 与凭据，不动用户其它条目，清理后完全还原', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-dsh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const patch = path.join(root, 'cordis.patch.yml');
  const credentials = path.join(root, '.credentials.yaml');
  // 用户已有自己的 provider、默认模型与凭据，导入后必须全部保留
  const before = [
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'ide2api', model: 'workbuddy_cn-Deepseek-V4.1-Flash' } },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { ide2api: { baseURL: 'https://example.test/v1', models: [{ id: 'a' }] } } } },
    { id: 'ui-theme', name: '@deepseek-ai/dsh-client-ui-theme', config: { preference: 'dark' } },
  ];
  await fs.writeFile(patch, yaml.dump(before));
  await fs.writeFile(credentials, yaml.dump({ version: 1, refs: { IDE2API_API_KEY: 'keep-me' } }));
  const base = createClients({ home: root, platform: 'win32' }).find(c => c.id === 'dsh');
  const dsh = { ...base, locate: () => patch, credentials: () => credentials };
  assert.ok(base, 'dsh 客户端已注册');
  // dsh 从配置读取能力声明，因此图片支持必须写进 input，否则附件会被静默丢弃
  const withImage = [{ id: 'a', name: 'A', images: true }, { id: 'b', name: 'B' }];

  const result = await importIntoClient(dsh, withImage, 'http://127.0.0.1:41980/v1', 'bridge-secret');
  assert.equal(result.changed, true);
  assert.equal(result.needsKey, undefined, '密钥可代写，无需用户手动补填');
  const after = parsePatch(await fs.readFile(patch, 'utf8'));
  // 本应用的 provider 追加在末尾，用户原有条目逐条不变
  assert.deepEqual(after.slice(0, before.length), before);
  assert.equal(after.filter(e => e.id === 'agent-default-model').length, 1, '不产生重复的默认模型条目');
  const provider = after.find(e => e.id === 'ow-bridge-llm').config.providers['ow-bridge'];
  assert.equal(provider.baseURL, 'http://127.0.0.1:41980/v1');
  assert.equal(provider.api, 'openai-completions');
  assert.equal(provider.apiKeyEnv, 'OW_BRIDGE_API_KEY', '密钥通过环境变量名引用，不写入 patch');
  assert.deepEqual(provider.models.map(m => m.id), IDS, '模型 id 使用客户端可见名');
  assert.deepEqual(provider.models[0].input, ['text', 'image'], '支持图片的模型声明 image 输入');

  // 凭据写入本应用的键，用户原有键保留
  const creds = yaml.load(await fs.readFile(credentials, 'utf8'));
  assert.equal(creds.refs.IDE2API_API_KEY, 'keep-me');
  assert.equal(creds.refs.OW_BRIDGE_API_KEY, 'bridge-secret');

  // 重复导入不写入
  assert.equal((await importIntoClient(dsh, withImage, 'http://127.0.0.1:41980/v1', 'bridge-secret')).changed, false);

  // 清理后 patch 与凭据都回到原状
  await removeFromClient(dsh, withImage, 'http://127.0.0.1:41980/v1', 'bridge-secret');
  assert.deepEqual(parsePatch(await fs.readFile(patch, 'utf8')), before);
  const credsAfter = yaml.load(await fs.readFile(credentials, 'utf8'));
  assert.equal(credsAfter.refs.OW_BRIDGE_API_KEY, undefined, '清理后不残留密钥');
  assert.equal(credsAfter.refs.IDE2API_API_KEY, 'keep-me');
});

test('dsh patch 格式非法时拒绝写入', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-dsh-bad-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const patch = path.join(root, 'cordis.patch.yml');
  const credentials = path.join(root, '.credentials.yaml');
  await fs.writeFile(patch, 'key: value\n');
  await fs.writeFile(credentials, 'refs: {}\n');
  const dsh = { ...createClients({ home: root, platform: 'win32' }).find(c => c.id === 'dsh'), locate: () => patch, credentials: () => credentials };
  await assert.rejects(importIntoClient(dsh, MODELS, 'e', 'k'), /格式无法识别/);
  assert.equal(await fs.readFile(patch, 'utf8'), 'key: value\n');
});

// 各客户端要求的接口地址形态不同：WorkBuddy 与 Trae 系要完整路径，
// ZCode 与 DSH 要 base URL。传错会拼出重复路由。
test('Trae 条目补全完整路径，ZCode/DSH 保持 base URL 不重复拼接', async () => {
  const base = 'http://127.0.0.1:41980/v1';
  const full = `${base}/chat/completions`;
  // Trae 收到 base URL 时自行补路径
  assert.equal(traeEntry({ id: 'a', name: 'A' }, base).base_url, full);
  // 已经带路径时不重复追加
  assert.equal(traeEntry({ id: 'a', name: 'A' }, full).base_url, full);

  const zcode = createClients({ home: 'C:\h', platform: 'win32' }).find(c => c.id === 'zcode');
  const rule = zcodeMerge({ config: {} }, MODELS, base, 'k').document.config.providerConfigRules.providerRules[0];
  assert.equal(rule.config.api.baseUrl, base, 'ZCode 只写 base URL，不带 /chat/completions');

  const entry = dshProviderEntry(MODELS, base, 'ENV');
  assert.equal(entry.config.providers['ow-bridge'].baseURL, base, 'DSH 只写 base URL');
});
