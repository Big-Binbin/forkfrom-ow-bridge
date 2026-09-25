import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export async function validateModelsFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file).toLowerCase() !== 'models.json')
    throw new Error('请选择 WorkBuddy 的 models.json 配置文件');
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(document) && !Array.isArray(document?.models))
    throw new Error('文件不是支持的 WorkBuddy 模型配置格式');
  return file;
}

export async function resolveModelsFile({ saved, env = process.env, home = os.homedir() } = {}) {
  // A remembered or explicit location must never silently fall back to another profile.
  const file = env.BUDDY_MODELS_FILE || saved || path.join(env.WORKBUDDY_CONFIG_DIR?.trim() || path.join(home, env.WORKBUDDY_DATA_FOLDER_NAME?.trim() || '.workbuddy'), 'models.json');
  try { return await validateModelsFile(file); } catch { return null; }
}
