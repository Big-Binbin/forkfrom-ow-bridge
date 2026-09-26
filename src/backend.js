import { BridgeError, decode, completion } from './protocol.js';
import { buildHandoff, handoffInput, rejectFeedback } from './handoff.js';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
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
  }).map(([id, m]) => ({ id: `opencode/${id}`, name: m.name || id, context: m.limit?.context, input: m.limit?.input, images: m.capabilities?.input?.image === true, output: m.limit?.output, toolcall: m.capabilities?.toolcall === true, reasoning: m.capabilities?.reasoning === true, variants: m.variants ?? {} }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Approval payloads can carry file content; keep the shape but bound long strings.
export function shrinkPermission(value, limit = 400) {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}…[${value.length} chars]` : value;
  if (Array.isArray(value)) return value.map(item => shrinkPermission(item, limit));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrinkPermission(item, limit)]));
  return value;
}

export class Backend {
  constructor(base, password, timeout, log = () => {}) {
    Object.assign(this, { base, password, timeout, log, active: new Map(), events: null, toolParts: new Map() });
  }
  headers() {
    return { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}` };
  }
  async request(route, method = 'GET', body, signal, timeout = this.timeout) {
    const requestSignal = timeout == null ? signal : AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    return new Promise((resolve, reject) => {
      // Local inference has no proxy-owned deadline or HTTP client's implicit response timeout.
      const req = httpRequest(this.base + route, {
        method, signal: requestSignal, headers: this.headers(),
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (response.statusCode < 200 || response.statusCode >= 300)
            return reject(new BridgeError(`OpenCode HTTP ${response.statusCode}: ${text.slice(0, 600)}`, response.statusCode >= 500 ? 502 : response.statusCode, 'upstream_error'));
          try { resolve(JSON.parse(text)); }
          catch { reject(new BridgeError('OpenCode returned non-JSON response', 502, 'upstream_error')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(0);
      req.end(body !== undefined ? JSON.stringify(body) : undefined);
    });
  }

  // One event-stream connection serves every in-flight request: OpenCode reports its own
  // upstream retries there, which the request/response path never exposes. A 5-minute wait
  // with no output at all is a real user-visible failure mode, so it must be observable.
  watchEvents() {
    if (this.events) return;
    const controller = new AbortController();
    this.events = controller;
    (async () => {
      while (!controller.signal.aborted) {
        try { await this.streamEvents(controller.signal); }
        catch (e) { if (controller.signal.aborted) return; this.log(`Event stream error: ${e.message}`); }
        await delay(1000, undefined, { signal: controller.signal, ref: false }).catch(() => {});
      }
    })().catch(() => {});
  }
  stopEvents() {
    this.events?.abort();
    this.events = null;
  }
  streamEvents(signal) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(this.base + '/event', { method: 'GET', signal, headers: { ...this.headers(), Accept: 'text/event-stream' } }, response => {
        if (response.statusCode !== 200) { response.resume(); return reject(new BridgeError(`Event stream HTTP ${response.statusCode}`, 502, 'event_stream_error')); }
        let buffer = '';
        response.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            try { this.handleEvent(JSON.parse(line.slice(5).trim())); } catch {}
          }
        });
        response.on('error', reject);
        response.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });
  }
  handleEvent(wrapper) {
    const event = wrapper?.payload ?? wrapper;
    // The tool part carries the name and arguments of a call that an approval gate blocked.
    // It arrives here before the approval does, and the HTTP listing of messages does not.
    const part = event?.type === 'message.part.updated' ? event.properties?.part : undefined;
    if (part?.type === 'tool' && part.callID) {
      this.toolParts.set(part.callID, { tool: part.tool, input: part.state?.input ?? {} });
      if (this.toolParts.size > 50) this.toolParts.delete(this.toolParts.keys().next().value);
    }
    const sessionID = event?.properties?.sessionID;
    const meta = sessionID ? this.active.get(sessionID) : undefined;
    if (!meta || typeof meta.activity !== 'function') return;
    const status = event.properties?.status;
    const progress = { sessionID, model: meta.model, type: event.type, at: Date.now() };
    if (event.type === 'session.status' && status) {
      progress.status = status.type;
      if (status.type === 'retry') Object.assign(progress, { attempt: status.attempt, message: status.message, next: status.next });
    }
    if (event.type === 'session.error') progress.error = event.properties?.error?.data?.message || event.properties?.error?.name || '上游错误';
    if (event.type === 'message.part.updated') progress.part = event.properties?.part?.type;
    if (event.type === 'permission.updated') progress.status = 'permission';
    meta.activity(progress);
  }

  reject(permission, message, signal) {
    return this.request(`/permission/${encodeURIComponent(permission.id)}/reply`, 'POST', { reply: 'reject', message }, signal, 5000);
  }
  // The name of the blocked call comes from the event stream; the arguments may still be
  // empty while the part is pending, and handoffInput() then fills them from the approval.
  async blockedAction(callID, signal) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const part = this.toolParts.get(callID);
      if (part?.tool) return part;
      await delay(120, undefined, { signal, ref: false }).catch(() => {});
    }
    return { failure: 'no event carried this call ID' };
  }
  async pendingPermissions(sessionID, signal) {
    const pending = await this.request('/permission', 'GET', undefined, signal, 5000).catch(() => null);
    if (!Array.isArray(pending)) return null;
    return pending.filter(p => p.sessionID === sessionID);
  }
  // Refuse one native approval, or hand it to the external client. Returns { handoff } when
  // the action was handed over, so the caller can stop this generation and answer with it.
  async handlePermission(p, request, signal, rejected, meta) {
    const callID = p.tool?.callID;
    if (callID && rejected.has(callID)) return null;
    if (callID) rejected.add(callID);
    meta.nativeAttempts += 1;
    // Keep the approval request verbatim: OpenCode's field names differ from the SDK
    // types, so cherry-picking fields silently loses the useful ones.
    if (meta.permissions.length < 5) meta.permissions.push(shrinkPermission(p));
    const action = callID ? await this.blockedAction(callID, signal) : null;
    const native = action?.tool ?? (p.metadata?.command ? 'bash' : null);
    const handoff = native ? buildHandoff({ native, input: handoffInput(action, p), tools: request.tools }) : null;
    if (!handoff) meta.handoffCheck = { native: native ?? null, offeredTools: request.tools.length, detail: action?.failure ?? 'arguments incomplete for the external schema' };
    if (handoff) {
      await this.reject(p, 'This native action is executed by the external client instead.', signal).catch(() => {});
      return { handoff };
    }
    const reason = !callID ? 'the approval request carries no call ID, so it cannot be matched to the external tool list'
      : action ? 'its arguments cannot be mapped onto an external tool schema supplied in this request'
        : 'the call could not be read back from the session';
    // Without the tool part, name what can be known instead of blaming the permission kind.
    const label = native || (p.metadata?.filepath ? `a file operation on ${p.metadata.filepath}` : p.permission || 'native tool');
    // A permission may already be gone (session aborted, duplicate reply): never let that
    // failing reply take the whole request down with it.
    await this.reject(p, rejectFeedback(label, reason), signal).catch(() => {});
    return null;
  }

  async models() {
    const result = freeModels(await this.request('/provider'));
    if (!result.length) throw new Error('No free text models found; existing list preserved');
    return result;
  }
  async complete(request, signal, meta = {}) {
    meta.steps = 0; meta.nativeAttempts = 0; meta.permissions = [];
    // Native tools require approval; the bridge aborts any attempted native action.
    const session = await this.request('/session', 'POST', { title: 'Buddy Bridge', permission: Object.entries(nativePermissions).map(([permission, action]) => ({ permission, pattern: '*', action })) }, signal);
    const route = `/session/${encodeURIComponent(session.id)}`;
    meta.sessionID = session.id;
    if (typeof meta.activity === 'function') { this.active.set(session.id, meta); this.watchEvents(); }
    const guard = new AbortController();
    const rejected = new Set();
    const guardSignal = AbortSignal.any([guard.signal, ...(signal ? [signal] : [])]);
    const watch = (async () => {
      while (!guardSignal.aborted) {
        const pending = await this.pendingPermissions(session.id, guardSignal);
        if (pending === null) throw new BridgeError('Permission monitor unavailable', 502, 'permission_monitor_error');
        for (const p of pending) {
          if (request.chatOnly) throw new BridgeError('Chat-only model attempted native tool use; execution blocked', 502, 'native_tool_activity');
          const result = await this.handlePermission(p, request, guardSignal, rejected, meta);
          if (result?.handoff) return result;
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
      const payload = {
        model: { providerID: 'opencode', modelID: request.model.id.slice('opencode/'.length) },
        ...(request.variant ? { variant: request.variant } : {}),
        agent: request.chatOnly ? 'buddy-chat' : 'buddy-bridge', system: request.chatOnly ? request.system : request.system + '\nUse StructuredOutput to return this envelope. All other native tools are forbidden; do not perform the external actions yourself.',
        ...(request.chatOnly ? {} : { format: { type: 'json_schema', retryCount: 0, schema: {
          type: 'object', properties: { content: { type: 'string' }, calls: callsSchema },
          required: ['content', 'calls'], additionalProperties: false,
        } } }),
        parts: [{ type: 'text', text: request.text }, ...(request.images ?? [])],
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        meta.steps += 1;
        const response = await Promise.race([watch, this.request(`${route}/message`, 'POST', payload, signal, null)]);
        let handoff = response?.handoff ?? null;
        if (!handoff) {
          // Close the race: an approval raised just before the response landed must still be
          // refused or handed over, otherwise its tool part looks like unexpected activity.
          const late = await this.pendingPermissions(session.id, guardSignal);
          for (const p of late ?? []) {
            if (request.chatOnly && p.tool) throw new BridgeError('Chat-only model attempted native tool use; execution blocked', 502, 'native_tool_activity');
            const result = await this.handlePermission(p, request, guardSignal, rejected, meta);
            if (result?.handoff) { handoff = result.handoff; break; }
          }
        }
        // A handed-over action becomes the model's answer; no second upstream turn is spent.
        if (handoff) {
          await this.request(`${route}/abort`, 'POST', undefined, undefined, 5000).catch(() => {});
          meta.calls = 1;
          meta.handoff = handoff.name;
          successful = true;
          return completion(request.model.id, { role: 'assistant', content: null,
            tool_calls: [{ id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function',
              function: { name: handoff.name, arguments: JSON.stringify(handoff.arguments) } }] }, undefined);
        }
        if (response.info?.error && (request.chatOnly || response.info.error.name !== 'StructuredOutputError')) {
          const error = response.info.error;
          throw new BridgeError(error.data?.message || error.message || error.name || 'Model request failed', error.data?.statusCode || 502, 'model_error');
        }
        if (response.parts?.some(p => p.type === 'tool' && (request.chatOnly || p.tool !== 'StructuredOutput') && !(rejected.has(p.callID) && p.state?.status === 'error'))) throw new BridgeError('Unexpected native tool activity; response rejected', 502, 'native_tool_activity');
        if (response.info?.finish === 'length') throw new BridgeError('Model output was truncated', 502, 'output_truncated');
        // The envelope arrives one of three ways: OpenCode's structured field, the completed
        // StructuredOutput call this adapter asks for, or plain text. Reading only the first
        // and the last rejected a correct answer once, so all three are accepted.
        const structuredPart = (response.parts || []).find(p => p.type === 'tool' && p.tool === 'StructuredOutput' && p.state?.status === 'completed' && p.state?.input);
        const envelope = response.info?.structured ?? structuredPart?.state?.input;
        const text = envelope !== undefined ? JSON.stringify(envelope) : (response.parts || []).filter(p => p.type === 'text').map(p => p.text).join('');
        if (!text.trim()) throw new BridgeError(request.chatOnly ? 'Model returned no text' : '模型没有返回信封：structured、已完成的 StructuredOutput 调用、文本 part 三者都为空', 502, request.chatOnly ? 'empty_response' : 'invalid_model_output');
        let message;
        try { message = request.chatOnly ? { role: 'assistant', content: text } : decode(text, request); }
        catch (error) {
          if (attempt || request.chatOnly || error.code !== 'invalid_model_output' || signal?.aborted) throw error;
          payload.parts = [{ type: 'text', text: 'Your previous response failed the adapter JSON format check. No external tool has been executed from that response. Return the intended answer or external tool proposal using StructuredOutput with exactly {"content":"a string, empty if only calling tools","calls":[{"name":"an allowed external tool name","arguments":{}}]}. Both fields are required; use [] when no tools are needed. Do not invoke native tools, repeat external searches, or claim actions have completed. Preserve the external conversation and its existing tool results.' }];
          continue;
        }
        meta.calls = message.tool_calls?.length ?? 0;
        successful = true;
        return completion(request.model.id, message, response.info?.tokens);
      }
    } finally {
      guard.abort();
      await watch.catch(() => {});
      if (typeof meta.activity === 'function') {
        meta.activity({ sessionID: session.id, model: meta.model, type: 'request.done' });
        this.active.delete(session.id);
      }
      // Cancellation must stop backend work, not merely disconnect the HTTP request.
      if (!successful) await this.request(`${route}/abort`, 'POST', undefined, undefined, 5000).catch(() => {});
      await this.request(route, 'DELETE', undefined, undefined, 5000).catch(e => console.error('Session cleanup failed:', e.code || e.name));
    }
  }
}
