import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveModelsFile, validateModelsFile } from '../src/workbuddy-config.js';
import { syncModels } from '../src/sync.js';

test('configuration discovery respects explicit and remembered locations without guessing or creating files', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'buddy-config-'));
  try {
    const defaultFile = path.join(home, '.workbuddy', 'models.json');
    assert.equal(await resolveModelsFile({ home, env: {} }), null);
    await assert.rejects(fs.stat(path.dirname(defaultFile)), { code: 'ENOENT' });
    await fs.mkdir(path.dirname(defaultFile));
    await fs.writeFile(defaultFile, '[]');
    assert.equal(await resolveModelsFile({ home, env: {} }), defaultFile);
    const customDir = path.join(home, '自定义配置');
    const customFile = path.join(customDir, 'models.json');
    await fs.mkdir(customDir); await fs.writeFile(customFile, '{"models":[]}');
    assert.equal(await resolveModelsFile({ home, env: { WORKBUDDY_CONFIG_DIR: customDir } }), customFile);
    assert.equal(await resolveModelsFile({ home, env: { WORKBUDDY_DATA_FOLDER_NAME: '自定义配置' } }), customFile);
    assert.equal(await resolveModelsFile({ home, env: {}, saved: customFile }), customFile);
    assert.equal(await resolveModelsFile({ home, env: { BUDDY_MODELS_FILE: defaultFile }, saved: customFile }), defaultFile);
    await fs.unlink(customFile);
    assert.equal(await resolveModelsFile({ home, env: {}, saved: customFile }), null, 'Never fall back to a different profile');
    await assert.rejects(syncModels(customFile, [], 'endpoint', 'key', { allowEmpty: true, requireExisting: true }), { code: 'ENOENT' });
    await assert.rejects(fs.stat(customFile), { code: 'ENOENT' });
    await fs.writeFile(customFile, '{"other":"settings"}');
    await assert.rejects(validateModelsFile(customFile), /配置格式/);
    assert.equal(await resolveModelsFile({ home, env: {}, saved: customFile }), null);
    await fs.writeFile(customFile, 'invalid');
    await assert.rejects(validateModelsFile(customFile));
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
