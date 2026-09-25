import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { prepare, sendSSE, BridgeError } from './protocol.js';

function authorized(req, key) {
  const actual = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${key}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readBody(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw new BridgeError('Request exceeds 8 MB', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new BridgeError('Invalid JSON'); }
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }

export function createServer({ key, backend, getModels, refresh, status, onResult = () => {} }) {
  const active = new Set();
  const server = http.createServer(async (req, res) => {
    if (!authorized(req, key)) return json(res, 401, { error: { message: 'Local proxy API key required', type: 'authentication_error' } });
    // No browser origins are allowed. WorkBuddy talks to this service through its native runtime.
    if (req.headers.origin) return json(res, 403, { error: { message: 'Browser-origin requests are disabled' } });
    const route = new URL(req.url, 'http://127.0.0.1').pathname;
    const controller = new AbortController(); active.add(controller);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    let heartbeat, model;
    try {
      if (req.method === 'GET' && route === '/health') return json(res, 200, status());
      if (req.method === 'GET' && route === '/v1/models') return json(res, 200, { object: 'list', data: getModels().map(m => ({ id: m.id, object: 'model', owned_by: 'opencode', name: m.name })) });
      if (req.method === 'POST' && route === '/admin/refresh') return json(res, 200, await refresh());
      if (req.method !== 'POST' || route !== '/v1/chat/completions') return json(res, 404, { error: { message: 'Not found' } });
      if (active.size > 4) throw new BridgeError('At most four requests may run at once', 429, 'busy');
      const body = await readBody(req);
      model = body.model;
      const request = prepare(body, getModels());
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(': validating model response before emission\n\n');
        heartbeat = setInterval(() => res.write(': waiting\n\n'), 10000);
      }
      const result = await backend.complete(request, controller.signal);
      onResult(body.model, true);
      if (controller.signal.aborted) return;
      if (body.stream) sendSSE(res, result, body.stream_options?.include_usage);
      else json(res, 200, result);
    } catch (e) {
      if (controller.signal.aborted) return;
      const message = e.name === 'TimeoutError' ? 'Model request timed out' : e.message;
      onResult(model || null, false, message);
      const error = { message, type: e.code || 'upstream_error', code: e.code || 'upstream_error' };
      if (res.headersSent) res.end(`data: ${JSON.stringify({ error })}\n\n`);
      else json(res, e.status || 502, { error });
    } finally { clearInterval(heartbeat); active.delete(controller); }
  });
  server.requestTimeout = 20000; server.headersTimeout = 15000;
  server.abortAll = () => { for (const c of active) c.abort(); };
  return server;
}
