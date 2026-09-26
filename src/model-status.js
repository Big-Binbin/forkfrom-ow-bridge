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

// A syntactically valid envelope is not the same as an executed action. WorkBuddy decides
// whether an action is needed, so a text-only reply stays usable, but it must never be
// displayed as a plain success and blocked native attempts must stay visible.
export function withRequestMeta(result, meta = {}, chatOnly = false) {
  if (!meta || typeof meta !== 'object') return result;
  if (Number.isInteger(meta.calls)) result.calls = meta.calls;
  if (Number.isInteger(meta.nativeAttempts)) result.nativeAttempts = meta.nativeAttempts;
  if (Number.isInteger(meta.steps)) result.steps = meta.steps;
  if (!chatOnly && Number.isInteger(meta.tools) && meta.tools > 0 && meta.calls === 0) result.noAction = true;
  return result;
}

export function clientModelID(model) { return `OC · ${model.name}`; }
