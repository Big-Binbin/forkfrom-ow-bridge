// The adapter's contract with the receiver is one JSON envelope. When a reply cannot be turned
// into that envelope, the bridge hands the raw material to a second model whose only job is the
// shape, and the receiver's own validator stays the authority: a translated envelope that names an
// unlisted tool or breaks the parameters schema is rejected exactly as the original reply was.
//
// Two jobs, both restore-only:
//   envelope - put what the model already produced into the documented shape
//   action   - express an already-blocked native action as the closest external call
// Neither job may invent a tool call, an argument value, or file content.

export const REPAIR_SYSTEM = [
  'You are a format adapter. You never answer the user and never decide what to do.',
  'The input is JSON: "shape" is the required output shape, "tools" lists the receiver tool names',
  'with their parameter schemas, "material" is everything the first model produced, and "blocked"',
  'is present when a native action was refused and needs an external expression.',
  'Reply with one JSON object and nothing else.',
  'For shape "envelope" reply exactly {"content":"...","calls":[{"name":"...","arguments":{}}]}.',
  'For shape "action" reply exactly {"name":"...","arguments":{}}.',
  'Restore only what the material already contains: reuse its text and its argument values verbatim.',
  'Never invent a tool call, an argument value, file content, or an action that is not in the material.',
  'When the material holds no complete action, reply with an empty calls array (or, for an action, null).',
  'Only tool names listed in "tools" are allowed, and the arguments must satisfy their schema.',
].join('\n');

const LIMIT = 6000;

// Bound everything: the material can carry whole files, and the translator only needs the shape.
export function bounded(value, limit = LIMIT, depth = 0) {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}…[${value.length} chars]` : value;
  if (Array.isArray(value)) return depth > 4 ? `[${value.length} items]` : value.slice(0, 20).map(item => bounded(item, limit, depth + 1));
  if (value && typeof value === 'object') {
    if (depth > 4) return '[object]';
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bounded(item, limit, depth + 1)]));
  }
  return value;
}

// Everything the first model produced, in one place. Reading only part of it is what once made a
// correct answer look like a broken one, so nothing is dropped here.
export function rawMaterial(response = {}) {
  const parts = (response.parts || []).map(part => ({
    type: part.type,
    ...(part.tool ? { tool: part.tool } : {}),
    ...(part.state?.status ? { status: part.state.status } : {}),
    ...(part.state?.input !== undefined ? { input: part.state.input } : {}),
    ...(part.text !== undefined ? { text: part.text } : {}),
  }));
  return bounded({
    finish: response.info?.finish ?? null,
    error: response.info?.error ? { name: response.info.error.name, message: response.info.error.message } : null,
    structured: response.info?.structured ?? null,
    parts,
    text: (response.parts || []).filter(part => part.type === 'text').map(part => part.text).join(''),
  });
}

export function toolCatalog(tools = []) {
  return tools.map(tool => ({ name: tool.function?.name, parameters: tool.function?.parameters }));
}

export function repairBody({ shape, tools, material, blocked }) {
  return JSON.stringify({ shape, tools: toolCatalog(tools), material, ...(blocked ? { blocked } : {}) });
}

// Models wrap JSON in prose or fences even when told not to, so take the first balanced object.
export function extractJson(text) {
  const source = String(text ?? '');
  const start = source.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (!depth) {
        try { return JSON.parse(source.slice(start, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// A chat-only request: the translator's job is text, so it must never reach for a tool.
export function translatorRequest(model, body) {
  return { model: { id: model }, chatOnly: true, tools: [], choice: 'none', images: [], system: REPAIR_SYSTEM, text: body };
}

// One attempt, bounded, and the failure is recorded either way so the panel can tell a repaired
// turn from an ordinary one.
export async function repair({ complete, translator, request, shape, material, blocked, validate, meta = {}, log = () => {} }) {
  const record = value => { meta.repaired = { ...(meta.repaired ?? {}), [shape]: value }; };
  const model = typeof translator === 'function' ? translator(request.model?.id, shape) : null;
  if (!model) { record({ ok: false, reason: 'no translator available' }); return null; }
  const started = Date.now();
  let candidate;
  try {
    const result = await complete(translatorRequest(model, repairBody({ shape, tools: request.tools, material, blocked })));
    candidate = extractJson(result?.choices?.[0]?.message?.content);
  } catch (error) {
    log(`translation (${shape}) failed: ${error?.message ?? error}`);
    record({ ok: false, model, ms: Date.now() - started, reason: error?.code ?? 'error' });
    return null;
  }
  if (!candidate) { record({ ok: false, model, ms: Date.now() - started, reason: 'unreadable reply' }); return null; }
  try {
    const value = validate(candidate);
    record({ ok: true, model, ms: Date.now() - started });
    return value;
  } catch (error) {
    // The receiver refused the translation: the original error is reported unchanged.
    record({ ok: false, model, ms: Date.now() - started, reason: error?.code ?? 'rejected by receiver' });
    return null;
  }
}
