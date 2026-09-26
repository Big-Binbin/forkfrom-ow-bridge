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
      const mapped = category.fields[key];
      if (!mapped || value === undefined || args[mapped] !== undefined) continue;
      if (Object.hasOwn(properties, mapped)) args[mapped] = value;
    }
    const required = Array.isArray(spec.parameters.required) ? spec.parameters.required : [];
    if (!Object.keys(args).length) continue;
    if (!required.every(key => args[key] !== undefined && args[key] !== null && args[key] !== '')) continue;
    return { name: spec.name, arguments: args };
  }
  return null;
}

// A rejection must name the tool and the reason: a silent or generic refusal leaves the
// model guessing, which is what produced repeated native attempts in the first place.
export function rejectFeedback(native, reason) {
  return `Native tool "${native}" was blocked: ${reason}. Native execution is forbidden; the external client owns execution. `
    + 'Return the requested external action inside the calls array using StructuredOutput. The external client will execute it and supply results. Do not call any other native tools.';
}
