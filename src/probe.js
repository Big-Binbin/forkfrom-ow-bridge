import { BridgeError } from './protocol.js';

// Detection must approximate real WorkBuddy traffic. The previous probe forced
// tool_choice: "required" with a single tool, so it only validated transport and format:
// a model that answers with text and proposes no action still passed, then wasted real
// turns (98 s and 58 s observed) while WorkBuddy saw nothing happen.
export const PROBE_TIMEOUT = 60000;

export const PROBE_TOOLS = [
  { type: 'function', function: { name: 'Read', description: 'Read a file from the external working directory.', parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Absolute path of the file to read' } }, required: ['file_path'] } } },
  { type: 'function', function: { name: 'Write', description: 'Write a file in the external working directory.', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } } },
  { type: 'function', function: { name: 'Bash', description: 'Run a shell command on the external machine.', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'Glob', description: 'List files matching a pattern.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'WebSearch', description: 'Search the web.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
];

// Several tools and a free choice, so the probe exercises the same path real traffic does.
export function probeBody(model, token) {
  return {
    model: model.id,
    messages: [{ role: 'user', content: `Read /external/probe-${token}.txt and report its contents.` }],
    tools: structuredClone(PROBE_TOOLS),
    parallel_tool_calls: false,
  };
}

// A text-only reply is the failure this probe exists to catch, not an acceptable answer.
export function judgeProbe(response, token) {
  const calls = response?.choices?.[0]?.message?.tool_calls;
  if (!calls?.length) throw new BridgeError('模型只返回了文本，没有产生任何动作', 502, 'no_action');
  let args = {};
  try { args = JSON.parse(calls[0].function?.arguments || '{}'); } catch {}
  if (calls.length !== 1 || calls[0].function?.name !== 'Read' || !String(args.file_path || '').includes(token))
    throw new BridgeError('模型返回的动作与请求不符', 502, 'invalid_tool_call');
  return calls[0];
}

// The probe owns its deadline: AbortSignal.any surfaces the abort as an opaque
// "The operation was aborted", which used to be reported as a generic error.
export function probeFailure(cause, timedOut) {
  if (!timedOut) return cause;
  const error = new BridgeError('Model probe timed out', 504, 'timeout');
  error.name = 'TimeoutError';
  return error;
}
