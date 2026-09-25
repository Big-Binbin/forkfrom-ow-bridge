import { BridgeError, decode, completion } from './protocol.js';
import { setTimeout as delay } from 'node:timers/promises';

// Keep official approval gates active. No native operation is ever approved.
export const nativePermissions = { '*': 'ask', question: 'deny', websearch: 'deny', codesearch: 'deny', webfetch: 'deny', task: 'deny', plan_enter: 'deny', plan_exit: 'deny', todowrite: 'deny' };

export function freeModels(providers) {
  const provider = providers.all?.find(p => p.id === 'opencode');
  if (!provider) throw new Error('OpenCode provider missing');
  return Object.entries(provider.models).filter(([, m]) => {
    const c = m.cost;
    return c && c.input === 0 && c.output === 0 && (c.cache?.read ?? 0) === 0 && (c.cache?.write ?? 0) === 0
      && m.capabilities?.output?.text !== false && m.status !== 'deprecated';
  }).map(([id, m]) => ({ id: `opencode/${id}`, name: m.name || id, context: m.limit?.input ?? m.limit?.context, output: m.limit?.output, toolcall: m.capabilities?.toolcall === true, reasoning: m.capabilities?.reasoning === true, variants: m.variants ?? {} }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export class Backend {
  constructor(base, password, timeout = 180000) {
    Object.assign(this, { base, password, timeout });
  }
  async request(route, method = 'GET', body, signal, timeout = this.timeout) {
    const response = await fetch(this.base + route, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
    });
    const text = await response.text();
    if (!response.ok) throw new BridgeError(`OpenCode HTTP ${response.status}: ${text.slice(0, 600)}`, response.status >= 500 ? 502 : response.status, 'upstream_error');
    try { return JSON.parse(text); } catch { throw new BridgeError('OpenCode returned non-JSON response', 502, 'upstream_error'); }
  }
  async models() {
    const result = freeModels(await this.request('/provider'));
    if (!result.length) throw new Error('No free text models found; existing list preserved');
    return result;
  }
  async complete(request, signal) {
    // Native tools require approval; the bridge aborts any attempted native action.
    const session = await this.request('/session', 'POST', { title: 'Buddy Bridge', permission: Object.entries(nativePermissions).map(([permission, action]) => ({ permission, pattern: '*', action })) }, signal);
    const route = `/session/${encodeURIComponent(session.id)}`;
    const guard = new AbortController();
    const rejected = new Set();
    const guardSignal = AbortSignal.any([guard.signal, ...(signal ? [signal] : [])]);
    const watch = (async () => {
      while (!guardSignal.aborted) {
        const pending = await this.request('/permission', 'GET', undefined, guardSignal, 5000);
        if (!Array.isArray(pending)) throw new BridgeError('Permission monitor unavailable', 502, 'permission_monitor_error');
        for (const p of pending.filter(p => p.sessionID === session.id)) {
          if (request.chatOnly) throw new BridgeError('Chat-only model attempted native tool use; execution blocked', 502, 'native_tool_activity');
          if (!p.tool?.callID || rejected.size >= 2) throw new BridgeError('OpenCode repeatedly attempted native actions; execution was not approved', 502, 'native_tool_activity');
          rejected.add(p.tool.callID);
          await this.request(`/permission/${encodeURIComponent(p.id)}/reply`, 'POST', {
            reply: 'reject', message: 'Native execution is forbidden. Return the requested external action inside the calls array using StructuredOutput. The external client will execute it and supply results. Do not call any other native tools.',
          }, guardSignal, 5000);
        }
        await delay(250, undefined, { signal: guardSignal });
      }
    })();
    let successful = false;
    try {
      const tools = request.choice === 'none' ? [] : request.tools.filter(t => !request.forced || t.function.name === request.forced);
      const callsSchema = { type: 'array', ...(request.parallel ? {} : { maxItems: 1 }),
        ...(request.choice === 'required' || request.forced ? { minItems: 1 } : {}),
        ...(tools.length ? { items: { anyOf: tools.map(({ function: tool }) => ({
          type: 'object', properties: { name: { type: 'string', const: tool.name }, arguments: tool.parameters || { type: 'object' } },
          required: ['name', 'arguments'], additionalProperties: false,
        })) } } : { maxItems: 0, items: { type: 'object' } }),
      };
      const response = await Promise.race([watch, this.request(`${route}/message`, 'POST', {
        model: { providerID: 'opencode', modelID: request.model.id.slice('opencode/'.length) },
        ...(request.variant ? { variant: request.variant } : {}),
        agent: request.chatOnly ? 'buddy-chat' : 'buddy-bridge', system: request.chatOnly ? request.system : request.system + '\nUse StructuredOutput to return this envelope. All other native tools are forbidden; do not perform the external actions yourself.',
        ...(request.chatOnly ? {} : { format: { type: 'json_schema', retryCount: 0, schema: {
          type: 'object', properties: { content: { type: 'string' }, calls: callsSchema },
          required: ['content', 'calls'], additionalProperties: false,
        } } }),
        parts: [{ type: 'text', text: request.text }],
      }, signal)]);
      if (response.info?.error && (request.chatOnly || response.info.error.name !== 'StructuredOutputError')) {
        const error = response.info.error;
        throw new BridgeError(error.data?.message || error.message || error.name || 'Model request failed', error.data?.statusCode || 502, 'model_error');
      }
      if (response.parts?.some(p => p.type === 'tool' && (request.chatOnly || p.tool !== 'StructuredOutput') && !(rejected.has(p.callID) && p.state?.status === 'error'))) throw new BridgeError('Unexpected native tool activity; response rejected', 502, 'native_tool_activity');
      if (response.info?.finish === 'length') throw new BridgeError('Model output was truncated', 502, 'output_truncated');
      const text = response.info?.structured !== undefined ? JSON.stringify(response.info.structured) : (response.parts || []).filter(p => p.type === 'text').map(p => p.text).join('');
      if (request.chatOnly && !text.trim()) throw new BridgeError('Model returned no text', 502, 'empty_response');
      const result = completion(request.model.id, request.chatOnly ? { role: 'assistant', content: text } : decode(text, request), response.info?.tokens);
      successful = true;
      return result;
    } finally {
      guard.abort();
      await watch.catch(() => {});
      // Cancellation must stop backend work, not merely disconnect the HTTP request.
      if (!successful) await this.request(`${route}/abort`, 'POST', undefined, undefined, 5000).catch(() => {});
      await this.request(route, 'DELETE', undefined, undefined, 5000).catch(e => console.error('Session cleanup failed:', e.code || e.name));
    }
  }
}
