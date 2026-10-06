// Supported clients and how to write bridged models into each one.
//
// The bridge used to know about exactly one product (WorkBuddy) and hard-coded its
// models.json layout in three places. This module replaces that with one adapter per client so
// adding a product means adding one descriptor, not editing the sync, UI and tray code.
//
// Shared contract for every adapter:
//   id        stable key stored in settings.json and used by the admin API
//   label     display name shown in the tray menu and the control panel
//   kind      'json' writes a JSON config file; 'vscdb' writes a VS Code state database
//   auto      whether the client can be imported with no manual step afterwards
//   locate()  absolute path of the config to write, or null when the client is not installed
//   merge()   pure function: (document, models, endpoint, key) => next document
//   note      extra guidance shown after import (a manual step the user must still perform)
import path from 'node:path';
import { clientModelID } from './model-status.js';

// Marker for entries this app owns. Import replaces its own entries only and never touches
// models the user configured by hand.
export const OWNER = 'buddy-bridge-v1';
// Grouping used by the UI to lay out the client list.
export const GROUPS = { chat: '对话客户端', ide: 'AI 编程工具' };

// Trae-family clients expose the same model list under seven agent groups. A model that is
// missing from a group is simply not offered by the agent reading that group, so every group
// must receive an identical copy of the entry.
export const TRAE_GROUPS = ['builder', 'builder_v3', 'chat_v3', 'code_reviewer', 'code_review_summary', 'refactor', 'solo_agent'];

// Trae identifies entries by a numeric handle and keeps the API key in an encrypted column.
// We can reproduce the structure but not the encryption, so those entries are written without
// a key and marked so the UI can tell the user to finish them inside the client.
const TRAE_PROVIDER = 'custom_openai_compatible';
const TRAE_BASE_PREFIX = 1000000000;

// Deterministic numeric handle for a Trae entry. Trae treats the value as opaque; a stable
// value means re-importing updates the existing entry instead of adding duplicates.
function traeModelHandle(modelID) {
  let hash = 0;
  for (let i = 0; i < modelID.length; i++) hash = (Math.imul(hash, 31) + modelID.charCodeAt(i)) >>> 0;
  return TRAE_BASE_PREFIX + hash % 900000000;
}

// Trae entry fields, matching the 47-field shape observed in a real client database.
// Only the fields that decide behaviour are set; the rest stay null as the client expects.
export function traeEntry(model, endpoint, { toolCalls = true } = {}) {
  // Trae sends this exact name back as the model id, so it must match the local API.
  const id = clientModelID(model);
  return {
    name: `${TRAE_PROVIDER}//${id}`,
    display_name: id,
    provider: TRAE_PROVIDER,
    // Trae stores the full route and appends nothing, so the path belongs here.
    base_url: endpoint.endsWith('/chat/completions') ? endpoint : `${endpoint}/chat/completions`,
    ak: null,
    sk: null,
    auth_type: 0,
    is_custom_base_url: true,
    client_connect: true,
    custom_model_id: String(traeModelHandle(id)),
    config_source: 3,
    model_type: 'chat_model',
    multimodal: model.images === true,
    prompt_max_tokens: model.input ?? model.context ?? 200000,
    max_tokens: model.output ?? 8192,
    thinking_enable: model.reasoning ? 1 : null,
    is_preset: false,
    is_default: false,
    selectable: true,
    status: true,
  };
}

function jsonClient({ id, label, group = 'chat', file, merge, auto = true }) {
  return { id, label, group, kind: 'json', auto, locate: () => file, merge };
}

function vscdbClient({ id, label, roaming, note }) {
  return {
    id, label, group: 'ide', kind: 'vscdb', auto: false,
    note,
    locate: ({ env }) => (env.APPDATA ? path.win32.join(env.APPDATA, roaming, 'User', 'globalStorage', 'state.vscdb') : null),
  };
}

// DeepSeek Harness composes its configuration from bundle layers plus a user patch file.
// The patch is plain YAML and the API key is referenced by environment-variable name, so this
// client needs no manual step after import.
function dshClient({ id, label, homeDir }) {
  return {
    id, label, group: 'chat', kind: 'yaml', auto: true,
    locate: () => path.win32.join(homeDir, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'),
    credentials: () => path.win32.join(homeDir, '.dsh', '.credentials.yaml'),
  };
}

// WorkBuddy: ~/.workbuddy/models.json, either a bare array or { models: [...] }.
// Returns the next document; this app's previous entries are dropped and new ones appended,
// while the user's own entries keep their order.
function workBuddyMerge(document, models, endpoint, key) {
  const isArray = Array.isArray(document);
  const list = isArray ? document : document?.models;
  const kept = (Array.isArray(list) ? list : []).filter(m => m?.buddyBridgeOwner !== OWNER);
  const conflicts = new Set(kept.map(m => m?.id).filter(Boolean));
  const entries = models
    .filter(m => !conflicts.has(clientModelID(m)))
    .map(m => ({
      // WorkBuddy shows the client-facing id, which carries the "OC · " prefix the bridge adds.
      id: clientModelID(m), name: clientModelID(m), vendor: 'Custom', url: endpoint, apiKey: key,
      supportsToolCall: !m.chatOnly, supportsImages: m.images === true,
      buddyBridgeOwner: OWNER,
    }));
  const combined = [...kept, ...entries];
  // The object form also tracks an availableModels list that must stay in sync.
  if (isArray) return { document: combined, entries, kept };
  const updated = { ...document, models: combined };
  if (Array.isArray(document?.availableModels)) {
    const removed = new Set(list.filter(m => m?.buddyBridgeOwner === OWNER && !kept.includes(m)).map(m => m.id));
    updated.availableModels = [...new Set([...document.availableModels.filter(id => !removed.has(id)), ...entries.map(m => m.id)])];
  }
  return { document: updated, entries, kept };
}

// ZCode: ~/.zcode/v2/provider_config.json. One provider owns every bridged model, so the merge
// rewrites only that provider's rule and its model rules and leaves other providers intact.
function zcodeMerge(document, models, endpoint, key) {
  const config = document?.config ?? {};
  const providerConfigRules = config.providerConfigRules ?? {};
  const modelConfigRules = config.modelConfigRules ?? {};
  const providerRules = Array.isArray(providerConfigRules.providerRules) ? providerConfigRules.providerRules : [];
  const providerModelRules = Array.isArray(modelConfigRules.providerModelRules) ? modelConfigRules.providerModelRules : [];
  const keptRules = providerRules.filter(r => r?.providerId !== ZCODE_PROVIDER_ID);
  const keptModels = providerModelRules.filter(r => r?.providerId !== ZCODE_PROVIDER_ID);
  // The client sends back the id we registered, so it must be the client-facing one the
  // local API accepts; the raw OpenCode id is not routable.
  const modelIds = models.map(m => clientModelID(m));
  // An empty model list means "remove": the provider rule, its model rules and its entry in
  // providerOrder all disappear, so removal restores the file exactly as it was.
  const order = (config.providerOrder ?? []).filter(id => id !== ZCODE_PROVIDER_ID);
  const next = {
    ...(document ?? {}),
    schemaVersion: document?.schemaVersion ?? 1,
    config: {
      ...config,
      ...(modelIds.length ? { providerOrder: [...new Set([...order, ZCODE_PROVIDER_ID])] } : { providerOrder: order }),
      providerConfigRules: {
        ...providerConfigRules,
        ...(modelIds.length ? { providerRules: [...keptRules, buildZcodeRule(modelIds, endpoint, key)] } : { providerRules: keptRules }),
      },
      modelConfigRules: {
        ...modelConfigRules,
        providerModelRules: [...keptModels, ...modelIds.map(modelId => ({ modelId, providerId: ZCODE_PROVIDER_ID, config: { enabled: true } }))],
      },
    },
  };
  return { document: next, entries: modelIds, kept: keptRules };
}

// One provider owns every bridged model. ZCode expects a plain OpenAI chat-completions endpoint
// with an API key, which is exactly what the local bridge serves.
function buildZcodeRule(modelIds, endpoint, key) {
  return {
    providerId: ZCODE_PROVIDER_ID,
    providerName: 'OW Bridge',
    config: {
      group: 'standard-personal',
      access: { type: 'api-key', apiKey: key },
      api: { type: 'openai-chat-completions', baseUrl: endpoint },
      personalModelIds: modelIds,
      modelOrder: modelIds,
    },
  };
}

export const ZCODE_PROVIDER_ID = 'ow-bridge';

// Build the client list for this machine. Windows hosts every supported client; macOS keeps the
// original WorkBuddy-only behaviour.
export function createClients({ env = process.env, home, platform = process.platform } = {}) {
  const homeDir = home ?? env.USERPROFILE ?? env.HOME;
  const clients = [];
  if (platform === 'win32') {
    clients.push(jsonClient({
      id: 'workbuddy', label: 'WorkBuddy',
      file: path.win32.join(homeDir, '.workbuddy', 'models.json'),
      merge: workBuddyMerge,
    }));
    clients.push(jsonClient({
      id: 'zcode', label: 'ZCode',
      file: path.win32.join(homeDir, '.zcode', 'v2', 'provider_config.json'),
      merge: zcodeMerge,
    }));
    clients.push(dshClient({ id: 'dsh', label: 'DeepSeek Harness', homeDir }));
    for (const c of [
      { id: 'traecodecn', label: 'TraeCode CN', roaming: 'Trae CN' },
      { id: 'traecode', label: 'TraeCode', roaming: 'Trae' },
      { id: 'traeworkcn', label: 'TraeWork CN', roaming: 'TRAE SOLO CN' },
      { id: 'qodercn', label: 'Qoder CN', roaming: 'Qoder CN' },
      { id: 'qoder', label: 'Qoder', roaming: 'Qoder' },
    ]) {
      clients.push(vscdbClient({
        ...c,
        note: 'Trae 系客户端的密钥由客户端自行加密保存，程序无法代写。请在客户端「添加模型」界面填入上方 API Key 后保存。',
      }));
    }
  } else if (platform === 'darwin') {
    clients.push(jsonClient({
      id: 'workbuddy', label: 'WorkBuddy',
      file: path.join(homeDir, '.workbuddy', 'models.json'),
      merge: workBuddyMerge,
    }));
  }
  return clients;
}

export { workBuddyMerge, zcodeMerge, TRAE_PROVIDER };