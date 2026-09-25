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

export function displayName(id, original) {
  return {
    'mimo-v2.6-flash-free': 'MiMo Flash',
    'space-bunny-free': 'Space Bunny',
    'ling-3.0-flash-fin-free': 'Ling Flash',
    'big-pickle': 'Big Pickle',
    'muse-spark-1.3-contributor-free': 'Muse Spark',
    'nemotron-3-ultra-free': 'Nemotron Ultra',
    'nemotron-3.5-lightning-free': 'Nemotron Lightning',
  }[id] || original;
}

export function clientModelID(model) { return `OC · ${model.name}`; }
