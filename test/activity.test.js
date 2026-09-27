import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import { Backend } from '../src/backend.js';
const { activityText } = createRequire(import.meta.url)('../desktop/activity.cjs');

test('progress distinguishes heartbeat from actual content and preserves bridge stages', () => {
  const backend = new Backend('http://unused', 'test');
  const events = [];
  const meta = { sessionID: 'ses_progress', model: 'opencode/test', activity: e => events.push(e) };
  backend.active.set(meta.sessionID, meta);
  backend.progress(meta, 'waiting');
  backend.handleEvent({ type: 'session.status', properties: { sessionID: meta.sessionID, status: { type: 'busy' } } });
  assert.equal(events.at(-1).content, undefined);
  backend.handleEvent({ type: 'message.part.delta', properties: { sessionID: meta.sessionID, delta: 'text' } });
  assert.equal(events.at(-1).content, true);
  assert.equal(events.at(-1).status, 'receiving');
  backend.progress(meta, 'repair', { repairModel: 'opencode/helper' });
  backend.handleEvent({ type: 'session.status', properties: { sessionID: meta.sessionID, status: { type: 'busy' } } });
  assert.equal(meta.stage, 'repair');
  assert.equal(events.at(-1).status, undefined);
  backend.handleEvent({ type: 'session.status', properties: { sessionID: meta.sessionID, status: { type: 'retry', attempt: 2 } } });
  assert.equal(events.at(-1).attempt, 2);
});

test('tray and browser share honest stage and elapsed-content labels', async () => {
  const a = { model: 'opencode/test', status: 'busy', waitedMs: 630000, sinceContentMs: null };
  assert.match(activityText(a), /等待上游返回.*630 秒.*尚未收到内容/);
  assert.doesNotMatch(activityText(a), /模型回复中|正在思考/);
  assert.match(activityText({ ...a, status: 'repair', repairModel: 'opencode/helper', sinceContentMs: 95000 }), /辅助模型转换格式（helper）.*最近内容 95 秒/);
  assert.match(activityText({ ...a, status: 'retry', attempt: 3 }), /重试第 3 次/);
  const browser = { window: {} };
  vm.runInNewContext(await fs.readFile(new URL('../desktop/activity.cjs', import.meta.url), 'utf8'), browser);
  assert.equal(browser.window.OWActivity.activityText(a), activityText(a));
});
