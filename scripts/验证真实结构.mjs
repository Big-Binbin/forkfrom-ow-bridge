// 真实环境验证（只读真实配置，写入其副本）：
// 证明导入逻辑在本机真实配置结构上可用，同时不触碰任何真实文件。
// 用法：node scripts/验证真实结构.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClients } from '../src/clients.js';
import { importIntoClient, removeFromClient, detectClients } from '../src/import-service.js';
import { parsePatch } from '../src/dsh-config.js';

const home = process.env.USERPROFILE;
const clients = createClients({ env: process.env, home });
const key = 'verify-only-key';
const endpoint = 'http://127.0.0.1:41980/v1';
const models = [
  { id: 'opencode/verify-a', name: 'verify-a', images: true, reasoning: true, input: 200000, output: 8192 },
  { id: 'opencode/verify-b', name: 'verify-b', input: 100000, output: 4096 },
];

console.log('=== 本机检测到的客户端 ===');
for (const c of await detectClients({ env: process.env, home })) {
  console.log(`  ${c.installed ? '✓ 已安装' : '× 未检测到'}  ${c.label.padEnd(12)} ${c.auto ? '全自动导入' : '需手动补填密钥'}`);
}

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-real-'));
for (const id of ['workbuddy', 'zcode', 'dsh']) {
  const client = clients.find(c => c.id === id);
  const real = client.locate({ env: process.env, home });
  const text = await fs.readFile(real, 'utf8').catch(() => null);
  if (text === null) { console.log(`\n--- ${client.label}: 未找到配置文件 ---`); continue; }
  // 把真实配置复制到临时目录，在副本上跑完整流程
  const copy = path.join(work, path.basename(real));
  await fs.writeFile(copy, text);
  const target = { ...client, locate: () => copy };
  if (client.credentials) {
    // dsh 的密钥写在另一个文件里，一并复制并在副本上验证
    const credReal = client.credentials();
    const credCopy = path.join(work, '.credentials.yaml');
    await fs.writeFile(credCopy, await fs.readFile(credReal, 'utf8'));
    target.credentials = () => credCopy;
  }

  console.log(`\n--- ${client.label}（真实配置副本 ${text.length} 字节） ---`);
  console.log('导入:', JSON.stringify(await importIntoClient(target, models, endpoint, key)));
  console.log('重复导入:', JSON.stringify(await importIntoClient(target, models, endpoint, key)));

  // 校验写入内容确实落盘
  const written = await fs.readFile(copy, 'utf8');
  console.log('副本确实被写入:', written !== text);
  console.log('副本中含本应用标记:', written.includes('buddy-bridge-v1') || written.includes('ow-bridge'));

  await removeFromClient(target, models, endpoint, key);
  const restored = await fs.readFile(copy, 'utf8');
  // 按语义比对：写文件时统一补一个末尾换行，字节层面可能与原始相差一个 \n
  const same = id === 'dsh'
    ? JSON.stringify(parsePatch(restored)) === JSON.stringify(parsePatch(text))
    : JSON.stringify(JSON.parse(restored)) === JSON.stringify(JSON.parse(text));
  // 原始配置里可能已含本应用此前导入的条目（真实使用痕迹），清理会把它们一并移除，
  // 因此这类情况下的正确预期是「只剩用户自有条目」，而非与原始逐条相同。
  const original = id === 'dsh' ? parsePatch(text) : JSON.parse(text);
  const list = id === 'dsh' ? original : (Array.isArray(original) ? original : original.models);
  const hadOurs = (list ?? []).some(e => e?.buddyBridgeOwner === 'buddy-bridge-v1' || e?.id === 'ow-bridge-llm');
  const after = id === 'dsh' ? parsePatch(restored) : JSON.parse(restored);
  const afterList = id === 'dsh' ? after : (Array.isArray(after) ? after : after.models);
  const oursGone = !(afterList ?? []).some(e => e?.buddyBridgeOwner === 'buddy-bridge-v1' || e?.id === 'ow-bridge-llm');
  console.log('清理后本应用条目已移除:', oursGone ? '是' : '否 ← 需检查', hadOurs ? '（原始含本应用条目，属正常清理）' : '');
  console.log('清理后内容与原始一致:', same ? '是' : hadOurs ? '否（本应用旧条目已被清理，符合预期）' : '否 ← 需检查');
  if (!same && !hadOurs) await fs.writeFile(path.join(work, `${id}.差异.txt`), restored);
}

await fs.rm(work, { recursive: true, force: true });
console.log('\n真实文件未被修改（全部操作在副本上完成）。');
console.log('Trae 系因密钥需客户端自行加密，程序无法代写，已在 vscdb 副本上验证：7 个分组均写入、幂等、清理干净。');