// 手动验证脚本：在真实 vscdb 副本上执行导入与清理，确认写入结构正确且可重复执行。
// 用法：node 验证trae写入.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeTraeModels, removeTraeModels, mergeGroups } from '../src/trae-store.js';
import { traeEntry } from '../src/clients.js';

const source = path.join(process.env.APPDATA, 'Trae CN', 'User', 'globalStorage', 'state.vscdb');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trae-verify-'));
const file = path.join(dir, 'state.vscdb');
await fs.copyFile(source, file);

// 造两个模型：一个大上下文的，一个不带图片的。name 是 OpenCode 里的显示名，
// 写入的 id 由 "OC · " + name 组成，与客户端实际回传的 model 字段一致。
const models = [
  { id: 'opencode/big-pickle', name: 'big-pickle', input: 200000, output: 8192, images: true, reasoning: true },
  { id: 'opencode/glm-5.3-flash', name: 'glm-5.3-flash', input: 100000, output: 4096 },
];
const endpoint = 'http://127.0.0.1:41980/v1';

function dump(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE '%model_list_map'").all();
  db.close();
  return rows.map(r => ({ key: r.key, doc: JSON.parse(String(r.value)) }));
}

const before = await dump(file);

const first = await writeTraeModels(file, models, endpoint);
console.log('首次写入:', JSON.stringify(first));

const after = await dump(file);
// 客户端回传的 model 名必须带 "OC · " 前缀，才能被本地接口识别
const NAME = 'custom_openai_compatible//OC · big-pickle';
// 每个分组都应有且仅有 1 条
for (const group of ['builder', 'builder_v3', 'chat_v3', 'code_reviewer', 'code_review_summary', 'refactor', 'solo_agent']) {
  const list = after[0].doc[group] || [];
  const hit = list.filter(m => m.name === NAME);
  console.log(`  ${group}: 本应用条目 ${hit.length} 条, 组内总数 ${list.length}`);
}
const entry = (after[0].doc.builder || []).find(m => m.name === NAME);
console.log('条目样例:', JSON.stringify({
  name: entry?.name, display_name: entry?.display_name, base_url: entry?.base_url, ak: entry?.ak,
  multimodal: entry?.multimodal, prompt_max_tokens: entry?.prompt_max_tokens,
  config_source: entry?.config_source, custom_model_id: entry?.custom_model_id,
}, null, 1));

const second = await writeTraeModels(file, models, endpoint);
console.log('重复导入(应为 changed:false):', JSON.stringify(second));

const removed = await removeTraeModels(file, models.map(m => `OC · ${m.name}`));
console.log('清理:', JSON.stringify(removed));
const final = await dump(file);
console.log('清理后 builder 中本应用条目数(应为0):',
  final[0].doc.builder.filter(m => m.name === NAME).length);
console.log('清理后原有自定义模型是否保留:', (final[0].doc.builder || []).filter(m => String(m.name).startsWith('custom_openai_compatible//') && !NAME.includes(m.name.replace('custom_openai_compatible//', ''))).length, '条');

await fs.rm(dir, { recursive: true, force: true });
console.log('验证完成，临时目录已清理:', dir);