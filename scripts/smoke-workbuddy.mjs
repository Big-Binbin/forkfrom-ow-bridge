// Opt-in integration test using WorkBuddy's installed engine and an isolated test directory.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const model = process.env.BUDDY_TEST_MODEL || 'OC · Space Bunny';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbuddy-bridge-'));
const file = path.join(root, 'verified.txt');
const cli = process.env.WORKBUDDY_CLI || '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';
const start = Date.now();
const { stdout, stderr } = await exec(cli, ['-p', `Use Write to create ${file} containing exactly WORKBUDDY_BRIDGE_OK. Wait for its result. Then use Read to read that exact absolute path and report its content. Do not access any other paths.`, '--model', `custom-local:${model}`, '--tools', 'Read,Write', '--allowedTools', 'Read', 'Write', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--no-session-persistence', '--max-turns', '6', '--output-format', 'json'], { cwd: root, timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
let events;
try { events = JSON.parse(stdout); } catch { throw new Error((stdout || stderr || "WorkBuddy returned no output").slice(-1500)); }
const calls = events.filter(e => e.type === 'function_call');
const results = events.filter(e => e.type === 'function_call_result');
assert.deepEqual(calls.map(c => c.name), ['Write', 'Read']);
for (const c of calls) assert.equal(JSON.parse(c.arguments).file_path, file);
assert.ok(results.every(r => r.status === 'completed'));
assert.equal(results.length, 2);
assert.ok(events.indexOf(results[0]) < events.indexOf(calls[1]), 'Read must wait for Write result');
assert.match(JSON.stringify(results.find(r => r.name === 'Read').output), /WORKBUDDY_BRIDGE_OK/);
assert.equal(await fs.readFile(file, 'utf8'), 'WORKBUDDY_BRIDGE_OK');
const final = events.find(e => e.type === 'result');
assert.equal(final?.is_error, false);
assert.match(final.result, /WORKBUDDY_BRIDGE_OK/);
console.log(JSON.stringify({ ok: true, model, durationMs: Date.now() - start, tools: calls.map(c => c.name), file, content: await fs.readFile(file, 'utf8') }, null, 2));
