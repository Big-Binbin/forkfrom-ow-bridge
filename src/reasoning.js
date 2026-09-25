// Only advertise effort controls that map to an actual OpenCode variant.
export function reasoningEfforts(model) {
  if (!model.reasoning) return {};
  return Object.fromEntries(Object.entries(model.variants ?? {})
    .filter(([, options]) => !options.disabled && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(options.reasoningEffort))
    .map(([variant, options]) => [options.reasoningEffort, variant]));
}

export function workBuddyReasoning(model) {
  const supportedEfforts = Object.keys(reasoningEfforts(model));
  const enabled = supportedEfforts.filter(e => e !== 'none');
  if (!model.reasoning) return { supportsReasoning: false };
  if (!enabled.length) return {
    supportsReasoning: true, onlyReasoning: true,
    reasoning: { supportedEfforts: [], canDisableThinking: false },
  };
  return {
    supportsReasoning: true,
    onlyReasoning: !supportedEfforts.includes('none'),
    reasoning: {
      supportedEfforts,
      defaultEffort: enabled.includes('medium') ? 'medium' : enabled[0],
      canDisableThinking: supportedEfforts.includes('none'),
    },
  };
}
