import { BridgeError } from './protocol.js';

// The external client owns execution. When the model tries to act locally, the blocked
// action is handed over as an external call instead of asking the model to restate it:
// restating is exactly the step models fail, and it costs a full extra upstream turn.
//
// The tool list WorkBuddy sends with each request is the authority. Only keys that exist
// in the target schema are filled, and every required key must be satisfiable, otherwise
// no handoff is produced and the call falls back to a corrective rejection.
const CATEGORIES = [
  { native: ['bash', 'shell'], targets: ['Bash', 'PowerShell'],
    fields: { command: 'command', description: 'description', timeout: 'timeout' } },
  { native: ['read'], targets: ['Read'],
    fields: { filePath: 'file_path', file_path: 'file_path', path: 'file_path', offset: 'offset', limit: 'limit' } },
  { native: ['write'], targets: ['Write'],
    fields: { filePath: 'file_path', file_path: 'file_path', path: 'file_path', content: 'content' } },
  { native: ['edit', 'multiedit', 'multi_edit', 'patch', 'apply_patch'], targets: ['Edit', 'MultiEdit'],
    fields: { filePath: 'file_path', file_path: 'file_path', path: 'file_path',
      oldString: 'old_string', old_string: 'old_string', newString: 'new_string', new_string: 'new_string',
      replaceAll: 'replace_all', replace_all: 'replace_all', edits: 'edits' } },
  // A field may have several acceptable target names: external tools disagree on spelling.
  { native: ['glob'], targets: ['Glob', 'LS'],
    fields: { pattern: 'pattern', path: ['path', 'directory'], include: 'include' } },
  { native: ['grep'], targets: ['Grep', 'Search'],
    fields: { pattern: 'pattern', path: ['path', 'directory'], include: 'include', output_mode: 'output_mode' } },
  { native: ['skill'], targets: ['Skill'],
    fields: { name: ['name', 'skill'], skill: ['skill', 'name'], args: ['args', 'arguments'], arguments: ['arguments', 'args'] } },
];

export function buildHandoff({ native, input = {}, tools = [] }) {
  const name = String(native ?? '').toLowerCase();
  const category = CATEGORIES.find(entry => entry.native.includes(name));
  if (!category) return null;
  for (const target of category.targets) {
    const spec = tools.map(tool => tool?.function).find(fn => fn?.name?.toLowerCase() === target.toLowerCase());
    const properties = spec?.parameters?.properties;
    if (!properties) continue;
    const args = {};
    for (const [key, value] of Object.entries(input)) {
      const candidates = category.fields[key];
      if (!candidates || value === undefined) continue;
      for (const mapped of Array.isArray(candidates) ? candidates : [candidates]) {
        if (args[mapped] !== undefined || !Object.hasOwn(properties, mapped)) continue;
        args[mapped] = value;
        break;
      }
    }
    const required = Array.isArray(spec.parameters.required) ? spec.parameters.required : [];
    if (!Object.keys(args).length) continue;
    if (!required.every(key => args[key] !== undefined && args[key] !== null && args[key] !== '')) continue;
    return { name: spec.name, arguments: args };
  }
  return null;
}

// While a call is still pending, OpenCode reports its arguments through the approval
// metadata, not through the tool part, whose input is empty until the call runs. The tool
// part wins when it has them; the metadata only fills what is missing.
export function handoffInput(action, permission) {
  const input = { ...(action?.input ?? {}) };
  const metadata = permission?.metadata ?? {};
  const fallback = {
    command: metadata.command,
    filePath: metadata.filepath ?? metadata.filePath ?? metadata.path,
    pattern: metadata.pattern ?? (Array.isArray(metadata.patterns) ? metadata.patterns[0] : undefined),
  };
  for (const [key, value] of Object.entries(fallback)) {
    if (input[key] === undefined && typeof value === 'string' && value.trim()) input[key] = value;
  }
  return input;
}

// A rejection must name the tool and the reason: a silent or generic refusal leaves the
// model guessing, which is what produced repeated native attempts in the first place.
export function rejectFeedback(native, reason) {
  return `Native tool "${native}" was blocked: ${reason}. Native execution is forbidden; the external client owns execution. `
    + 'Return the requested external action inside the calls array using StructuredOutput. The external client will execute it and supply results. Do not call any other native tools.';
}

// A translated action is not trusted: the receiver's schema decides, exactly as it does for the
// static table above. Same rules, so a translation can never widen what may be executed.
export function validateAction(candidate, tools = []) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new BridgeError('Translated action is not an object', 502, 'invalid_tool_call');
  const spec = tools.map(tool => tool?.function).find(fn => fn?.name && fn.name.toLowerCase() === String(candidate.name ?? '').toLowerCase());
  if (!spec) throw new BridgeError('Translated action names a tool the receiver did not offer', 502, 'invalid_tool_call');
  const args = candidate.arguments ?? {};
  if (typeof args !== 'object' || Array.isArray(args))
    throw new BridgeError('Translated action arguments are not an object', 502, 'invalid_tool_call');
  const properties = spec.parameters?.properties ?? {};
  for (const key of Object.keys(args)) if (!Object.hasOwn(properties, key))
    throw new BridgeError(`Translated action sets an argument the receiver does not declare: ${key}`, 502, 'invalid_tool_call');
  const required = Array.isArray(spec.parameters?.required) ? spec.parameters.required : [];
  if (!required.every(key => args[key] !== undefined && args[key] !== null && args[key] !== ''))
    throw new BridgeError('Translated action misses a required argument', 502, 'invalid_tool_call');
  return { name: spec.name, arguments: args };
}
