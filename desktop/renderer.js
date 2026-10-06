const $ = id => document.getElementById(id);
let state = {}, selected = null, pendingAction = false, lastModels = '', lastTargets = '';
// 勾选的导入目标客户端 id 列表，与后端 settings.targets 保持一致
let chosenTargets = new Set();
function element(tag, className, text) {
  const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el;
}

// 渲染可导入的客户端列表：已安装的可勾选，未安装的置灰不可选。
// Trae 系客户端导入后仍需在客户端内补填密钥，此处在选项下方给出提示。
function renderTargets() {
  const signature = JSON.stringify([state.clients, state.targets]);
  if (signature === lastTargets) return; lastTargets = signature;
  chosenTargets = new Set(state.targets || []);
  const list = $('targets-list');
  list.replaceChildren();
  const clients = state.clients || [];
  if (!clients.length) { list.append(element('p', 'empty', '未检测到支持的客户端。')); return; }
  for (const client of clients) {
    const row = element('label', 'target' + (client.installed ? '' : ' disabled'));
    const box = document.createElement('input');
    box.type = 'checkbox'; box.value = client.id; box.disabled = !client.installed;
    box.checked = chosenTargets.has(client.id);
    box.onchange = () => { box.checked ? chosenTargets.add(client.id) : chosenTargets.delete(client.id); render(); };
    const text = element('div', 'target-text');
    text.append(element('span', 'target-name', client.label));
    text.append(element('span', 'target-state', client.installed ? (client.auto ? '可全自动导入' : '需手动补填密钥') : '未检测到'));
    row.append(box, text);
    list.append(row);
  }
}
function waiting(id) { return state.probe?.running && state.probe?.pending?.includes(id); }
function label(model) {
  if (waiting(model.id)) return state.probe.current === model.id ? '检测中' : '等待检测';
  if ((state.activity || []).some(a => a.model === model.id)) return '请求中';
  const r = state.modelResults?.[model.id];
  if (state.availableModels?.includes(model.id)) return r?.chatOnly ? '可用 · 仅对话' : '可用';
  return ({ timeout: '检测超时', quota: '额度不足', rate_limit: '请求受限', access: '访问受限' })[r?.category] || (r?.ok === false ? '不可用' : '待检测');
}
function rank(model) { return waiting(model.id) ? 1 : state.availableModels?.includes(model.id) ? 0 : state.modelResults?.[model.id]?.ok === false ? 2 : 1; }
function timing(id) {
  const r = state.modelResults?.[id]; if (!Number.isFinite(r?.durationMs)) return '响应耗时 —';
  const duration = r.durationMs < 1000 ? `${r.durationMs} ms` : `${(r.durationMs / 1000).toFixed(1)} 秒`;
  return `最近${r.source === 'probe' ? '检测' : '调用'} · ${r.ok ? '响应' : '失败'}耗时 ${duration}`;
}
function renderModels() {
  const signature = JSON.stringify([state.models, state.modelResults, state.probe, state.availableModels, state.activity, selected]);
  if (signature === lastModels) return; lastModels = signature;
  const scroll = $('models').scrollTop;
  const focused = document.activeElement?.dataset?.model;
  $('models').replaceChildren();
  const models = [...(state.models || [])].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  for (const model of models) {
    const row = element('button', 'model' + (selected === model.id ? ' selected' : '')); row.dataset.model = model.id;
    row.setAttribute('aria-expanded', String(selected === model.id));
    const icon = element('span', 'model-icon'); icon.setAttribute('aria-hidden', 'true');
    icon.append(waiting(model.id) ? element('span', 'spinner') : element('span', '', '◇'));
    const info = element('div', 'model-info'); info.append(element('div', 'model-name', `OC · ${model.name}`), element('div', 'duration', timing(model.id)));
    const badges = element('div', 'badges');
    if (model.reasoning) badges.append(element('span', 'badge reasoning', '推理'));
    if (model.images) badges.append(element('span', 'badge images', '图片'));
    const status = label(model); badges.append(element('span', 'badge ' + (rank(model) === 2 ? 'unavailable' : rank(model) === 1 ? 'waiting' : ''), status));
    row.append(icon, info, badges); row.onclick = () => { selected = selected === model.id ? null : model.id; renderModels(); renderDetails(); };
    $('models').append(row);
    if (focused === model.id) row.focus({ preventScroll: true });
  }
  if (!models.length) $('models').append(element('p', 'empty', '正在安装或扫描模型，完成后将在这里显示。'));
  $('models').scrollTop = scroll;
}
function renderDetails() {
  const model = state.models?.find(m => m.id === selected); $('details').hidden = !model;
  if (!model) return;
  const r = state.modelResults?.[model.id] || {};
  $('details').replaceChildren(element('strong', '', model.id));
  const add = (text, css = '') => $('details').append(element('p', css, text));
  if (r.chatOnly) add('已自动关闭工具调用；导入后仅支持普通对话。');
  if (Number.isInteger(r.nativeAttempts) && r.nativeAttempts > 0) add(`最近一次调用拦截了 ${r.nativeAttempts} 次本地执行尝试，动作必须由 WorkBuddy 执行。`, 'error-text');
  if (Number.isInteger(r.calls) && r.calls > 0) add(`最近一次调用返回了 ${r.calls} 个动作。`);
  if (r.handoff) add(`最近一次调用把被拦下的本地动作转交成外部 ${r.handoff} 调用。`);
  const repairs = Object.entries(r.repaired ?? {}).filter(([, value]) => value?.ok);
  if (repairs.length) add(`这一轮由格式兜底救回：${repairs.map(([shape, value]) => `${shape === 'action' ? '动作转写' : '信封重排'}（${String(value.model).replace('opencode/', '')}）`).join('、')}。`);
  add(`图片输入：${model.images ? '支持' : '不支持'}`);
  add(`上下文：${model.context ?? '未声明'} · 输入上限：${model.input ?? '未单独声明'} · 输出上限：${model.output ?? '未声明'}`);
  const variants = Object.keys(model.variants || {});
  add(model.reasoning ? `推理：支持 · ${variants.length ? '可选档位：' + variants.join(' / ') : '使用默认模式'}` : '推理：OpenCode 未声明支持');
  if (r.error) add(r.error, 'error-text');
  add('最近更新：' + (r.time ? new Date(r.time).toLocaleString() : '尚未检测'));
}
function render() {
  const busy = pendingAction || state.actionBusy || state.configSearch?.running || state.probe?.running || state.phase !== 'ready';
  for (const id of ['refresh', 'probe', 'import', 'proxy']) $(id).disabled = !!busy;
  $('restart').hidden = state.phase !== 'error';
  $('restart').disabled = !!(pendingAction || state.actionBusy);
  // 未勾选任何客户端时导入按钮不可用，避免一次无意义的请求
  $('import').disabled = busy || chosenTargets.size === 0;
  $('proxy').disabled = !!(pendingAction || state.actionBusy || state.configSearch?.running || state.probe?.running || !['ready', 'error'].includes(state.phase));
  $('proxy').checked = state.useSystemProxy === true;
  $('service-text').textContent = window.OWActivity.activityText(state.activity?.[0]) || state.message || '正在启动隔离模型服务';
  $('service-dot').className = 'dot' + (state.phase === 'error' ? ' error' : '');
  $('discovered').textContent = state.models?.length || 0;
  $('available').textContent = state.availableModels?.length || 0;
  $('pending').textContent = state.models?.filter(m => rank(m) === 1).length || 0;
  for (const [id, title, active] of [['refresh', '读取免费模型', state.actionBusy === 'refresh'], ['probe', '检测全部', state.probe?.running], ['import', '导入所选客户端', state.actionBusy === 'import']]) {
    $(id).replaceChildren(); if (active) $(id).append(element('span', 'spinner'));
    $(id).append(document.createTextNode(active ? id === 'import' ? '正在导入…' : id === 'refresh' ? '正在读取…' : '正在检测…' : title));
  }
  const results = state.sync?.results;
  $('sync').textContent = (state.configSearch?.running ? 'OpenCode 正在只读查找 WorkBuddy 配置…' : '')
    || results?.find(r => r.error)?.error
    || (results?.length ? results.map(r => r.changed === false ? `${r.label} 已是最新` : `${r.label} 已写入 ${r.count} 个模型`).join(' · ') + (results.some(r => r.needsKey) ? '（Trae 系请在客户端内补填 API Key）' : '')
      : '首次读取和检测完成后自动导入');
  renderTargets(); renderModels(); renderDetails();
}
async function run(name, value) {
  if (pendingAction) return; pendingAction = true; $('feedback').hidden = true; render();
  try {
    const response = await window.buddy.action(name, value);
    if (!response.ok) throw new Error(response.error);
    if (name === 'import') {
      const r = response.result;
      // 汇总各客户端结果：Trae 系还需用户在客户端内补填密钥，给出明确提示与密钥内容
      const done = (r.results || []).filter(x => x.changed !== false);
      const same = (r.results || []).filter(x => x.changed === false);
      const parts = [];
      if (done.length) parts.push(`已导入 ${done[0].count} 个可用模型到：${done.map(x => x.label).join('、')}`);
      if (same.length) parts.push(`${same.map(x => x.label).join('、')} 配置已是最新`);
      const needKey = done.filter(x => x.needsKey);
      if (needKey.length) {
        parts.push(`\n\n以下客户端的 API Key 由客户端自行加密保存，程序无法代写，请复制后在客户端「添加模型」界面粘贴：\n\nAPI Key：${r.apiKey}\n接口地址：${r.endpoint}\n\n涉及：${needKey.map(x => x.label).join('、')}`);
      }
      feedback(parts.join('\n') || '已取消导入，配置未更改。');
    }
  } catch (error) { feedback(error.message, true); }
  finally { pendingAction = false; render(); }
}
function feedback(text, error = false) { $('feedback').textContent = text; $('feedback').className = error ? 'error' : ''; $('feedback').hidden = false; }
for (const action of ['refresh', 'probe', 'restart']) $(action).onclick = () => run(action);
// 导入时把当前勾选的客户端列表一并提交，由后端负责清理已取消勾选的旧目标
$('import').onclick = () => { if (chosenTargets.size) run('import', [...chosenTargets]); };
$('proxy').onchange = () => run('system-proxy', $('proxy').checked);
function dismiss() { selected = null; renderModels(); renderDetails(); }
document.addEventListener('click', e => { if (!e.target.closest('.model') && !e.target.closest('#details')) dismiss(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') dismiss(); });
window.buddy.onDismiss(dismiss);
window.buddy.onState(next => { state = next; render(); });
render();
