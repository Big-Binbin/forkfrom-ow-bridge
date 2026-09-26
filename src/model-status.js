// Provider errors do not expose a reliable remaining-balance API.
export function modelResult(ok, message = '', status, code) {
  let category = 'available';
  if (!ok) {
    if (/insufficient[_ ]quota|quota.{0,30}(exceed|exhaust|deplet)|out of credits|insufficient.{0,20}(credit|balance)|额度.{0,10}(不足|用尽)/i.test(message)) category = 'quota';
    else if (status === 429 || /rate.?limit|too many requests/i.test(message)) category = 'rate_limit';
    else if (status === 401 || status === 403) category = 'access';
    else if (/timeout|timed out/i.test(message)) category = 'timeout';
    else category = 'error';
  }
  return { ok, category, time: new Date().toISOString(), ...(message ? { error: message } : {}), ...(status ? { status } : {}), ...(code ? { code } : {}) };
}

// A request result carries what the adapter observed on this one work item (tool calls,
// blocked native attempts, steps, a handed-over action). It is an observation, not a
// verdict: capability labels come from detection only.
export function withRequestMeta(result, meta = {}) {
  if (!meta || typeof meta !== 'object') return result;
  if (Number.isInteger(meta.calls)) result.calls = meta.calls;
  if (Number.isInteger(meta.nativeAttempts)) result.nativeAttempts = meta.nativeAttempts;
  if (Number.isInteger(meta.steps)) result.steps = meta.steps;
  if (typeof meta.handoff === 'string') result.handoff = meta.handoff;
  if (meta.handoffCheck) result.handoffCheck = meta.handoffCheck;
  return result;
}

export function clientModelID(model) { return `OC · ${model.name}`; }
