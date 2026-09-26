// When a reply cannot be turned into what the client can run, the bridge hands the material to a
// second model: the conversation tail, everything the first model produced this turn, the client's
// tool schemas, and how this client expects those tools to be used. That is judgement guided by
// knowledge, not a form to fill in - but the client still decides: a name it did not offer, or
// arguments that break its schema, are refused however the translation was reached.
//
// Two jobs:
//   envelope - express the turn the client can run
//   action   - express an already-blocked native action as the closest external call
// An inferred call runs immediately in the working directory without confirmation, so the guidance
// asks for an action the conversation justifies, and for no call when nothing does.

export const REPAIR_SYSTEM = [
  'You adapt one turn of a coding agent so that its client can run it. You never answer the user',
  'yourself and you never take over the task.',
  'The input is JSON: "shape" says what to return, "tools" lists the client tool names with their',
  'parameter schemas, "conventions" describes how this client expects those tools to be used,',
  '"material" holds the conversation tail and everything the first model produced this turn, and',
  '"blocked" is present when a native action was refused and needs an external expression.',
  'Work out what the first model meant and express it as a call this client can run. Its own output',
  'may be cut short or garbled, so read the conversation for what it was doing, then use the',
  'schemas and the conventions to build the call.',
  'Only propose an action the conversation actually justifies. An inferred call runs immediately in',
  'the working directory without confirmation, so when nothing in the material supports an action,',
  'return no call rather than a plausible guess.',
  'Reply with one JSON object and nothing else.',
  'For shape "envelope" reply exactly {"content":"the answer text","calls":[{"name":"tool name","arguments":{}}]}.',
  'For shape "action" reply exactly {"name":"tool name","arguments":{}}.',
  'Use only the tool names listed in "tools", and make the arguments satisfy their schema.',
].join('\n');

// How this client's tools are actually used. Guidance only: the schemas in the request stay the
// authority, and a tool without a note is simply used with its schema.
export const CLIENT_CONVENTIONS = {
  bash: 'command is one POSIX shell string; the working directory is the session directory, so cd first or use absolute paths; keep it non-interactive.',
  powershell: 'command is one PowerShell string; prefer it only when the environment is Windows.',
  read: 'file_path is absolute; offset is a 1-based line number and limit is a line count.',
  write: 'file_path is absolute and content is the whole file; for a small change to an existing file prefer Edit.',
  edit: 'file_path is absolute; old_string must match the file exactly, including indentation, and new_string replaces it once unless replace_all is set.',
  glob: 'pattern is a glob relative to the search root; use it to find files, not contents.',
  grep: 'pattern is a regular expression, include restricts the file pattern, output_mode selects the shape of the result.',
  websearch: 'query is the search string; use it for facts the conversation does not already contain.',
  webfetch: 'url is absolute and http(s); use it only for a page already referenced in the conversation.',
  skill: 'name selects the skill and args carries its arguments.',
  agent: 'description is a 3-5 word label and prompt is the self-contained instruction for the worker.',
};

// The same tool is spelled differently by different clients; a note is found by family.
export const CONVENTION_ALIASES = {
  read: 'read', read_file: 'read', readfile: 'read', open_file: 'read', view: 'read',
  write: 'write', write_file: 'write', writefile: 'write', create_file: 'write', save_file: 'write',
  edit: 'edit', edit_file: 'edit', multiedit: 'edit', multi_edit: 'edit', apply_patch: 'edit', str_replace: 'edit', replace: 'edit',
  bash: 'bash', shell: 'bash', run_command: 'bash', execute_command: 'bash', terminal: 'bash', cmd: 'bash',
  powershell: 'powershell', pwsh: 'powershell',
  glob: 'glob', list_files: 'glob', ls: 'glob', find_files: 'glob', search_file: 'glob',
  grep: 'grep', search_content: 'grep', ripgrep: 'grep', rg: 'grep', codebase_search: 'grep',
  websearch: 'websearch', web_search: 'websearch', search_web: 'websearch',
  webfetch: 'webfetch', web_fetch: 'webfetch', fetch: 'webfetch', fetch_url: 'webfetch',
  skill: 'skill', agent: 'agent', task: 'agent',
};

export function clientConventions(tools = []) {
  return tools.map(tool => String(tool.function?.name ?? '').toLowerCase())
    .filter((name, index, all) => name && all.indexOf(name) === index)
    .map(name => [name, CLIENT_CONVENTIONS[CONVENTION_ALIASES[name] ?? name]])
    .filter(([, note]) => note)
    .map(([name, note]) => `${name}: ${note}`)
    .join('\n');
}

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

// The external conversation is half the evidence: without it a translated call can only guess.
// Kept to the tail so the material stays bounded.
export function conversationTail(request = {}, count = 6) {
  let messages;
  try { messages = JSON.parse(request.text ?? '[]'); } catch { return []; }
  if (!Array.isArray(messages)) return [];
  return messages.slice(-count).map(message => ({
    role: message?.role,
    ...(typeof message?.content === 'string' && message.content ? { content: message.content.slice(0, 1200) } : {}),
    ...(Array.isArray(message?.tool_calls) ? { tool_calls: message.tool_calls.slice(0, 3).map(call => ({ name: call?.function?.name, arguments: String(call?.function?.arguments ?? '').slice(0, 400) })) } : {}),
    ...(message?.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
  }));
}

// Everything the first model produced, in one place. Reading only part of it is what once made a
// correct answer look like a broken one, so nothing is dropped here.
export function rawMaterial(response = {}, request = {}) {
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
    conversation: conversationTail(request),
  });
}

export function toolCatalog(tools = []) {
  return tools.map(tool => ({ name: tool.function?.name, parameters: tool.function?.parameters }));
}

export function repairBody({ shape, tools, material, blocked }) {
  return JSON.stringify({ shape, tools: toolCatalog(tools), conventions: clientConventions(tools), material, ...(blocked ? { blocked } : {}) });
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
