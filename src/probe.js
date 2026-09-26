import { BridgeError } from './protocol.js';
import { randomBytes } from 'node:crypto';

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
  // A mismatch is not a format incompatibility: the envelope was valid, the action was
  // wrong. It must not be reported as an inability to carry tool calls, and the names that
  // did come back are part of the evidence.
  if (calls.length !== 1 || calls[0].function?.name !== 'Read' || !String(args.file_path || '').includes(token))
    throw new BridgeError(`模型返回的动作与探测请求不符（收到 ${calls.map(call => call?.function?.name || '未命名').join('、') || '无调用'}）`, 502, 'probe_mismatch');
  return calls[0];
}

// The chat-only fallback exists for models whose response format cannot carry tool
// calls. A model that keeps trying to execute locally is a different failure: publishing
// it as chat-only would hand WorkBuddy a model that can never act, and the panel would
// show "可用 · 仅对话" for a model that simply refused the adapter contract.
export function formatUnsupported(error) {
  return ['invalid_model_output', 'invalid_tool_call'].includes(error?.code)
    || /only.{0,10}auto.{0,40}supported.{0,20}tool_choice/i.test(error?.message || '');
}

// A semantic miss is a single stochastic event: retrying it once stops a model that
// passed before from being withdrawn on one unlucky response. A format failure belongs to
// the chat-only path, and a timeout reflects load rather than a fluke, so neither is
// retried here.
export const RETRYABLE_PROBE = new Set(['probe_mismatch', 'no_action']);

export async function probeModel({ complete, retries = 1 }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const token = randomBytes(8).toString('hex');
    try {
      const response = await complete(token);
      judgeProbe(response, token);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !RETRYABLE_PROBE.has(error.code)) throw error;
    }
  }
  throw lastError;
}

// The probe owns its deadline: AbortSignal.any surfaces the abort as an opaque
// "The operation was aborted", which used to be reported as a generic error.
export function probeFailure(cause, timedOut) {
  if (!timedOut) return cause;
  const error = new BridgeError('Model probe timed out', 504, 'timeout');
  error.name = 'TimeoutError';
  return error;
}
