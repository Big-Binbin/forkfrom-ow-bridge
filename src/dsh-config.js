// DeepSeek Harness (dsh) profile support.
//
// dsh composes its configuration from bundle layers plus a user patch file. The patch file is
// a plain YAML array of loader entries, and the one that matters for models is
// "@deepseek-ai/dsh-llm-pi-ai", which declares providers and the models each one serves.
//
// Unlike the Trae family, dsh keeps no encrypted key column: a provider references its key by
// environment-variable name (apiKeyEnv) and the value lives in .credentials.yaml. So this
// client is imported in full, without a manual step.
import yaml from 'js-yaml';
import { clientModelID } from './model-status.js';

// Entry id used for this app's provider. The client keys its config by id, so a stable value
// means re-importing updates the existing entry instead of stacking duplicates.
const DSH_ENTRY_ID = 'ow-bridge-llm';
const DSH_ENTRY_NAME = '@deepseek-ai/dsh-llm-pi-ai';
const DSH_PROVIDER_ID = 'ow-bridge';

// Parse a patch file into its loader entries. Returns an empty list for a missing file, which is
// how a fresh dsh profile looks before the user has ever customised anything.
export function parsePatch(text) {
  if (!text?.trim()) return [];
  const document = yaml.load(text);
  if (!Array.isArray(document)) throw new Error('dsh 配置格式无法识别，未做修改');
  return document;
}

// Serialise back in the style dsh writes: two-space indent, no document marker.
export function stringifyPatch(entries) {
  return yaml.dump(entries, { indent: 2, lineWidth: 120, noRefs: true, quotingType: '"' });
}

// The models a model entry should declare. DSH reads its own limits from here rather than
// probing the provider, so an undeclared image capability would silently drop attachments.
export function dshModel(model) {
  return {
    // dsh sends this id back as the model name, so it must be the client-facing one the local
    // API accepts rather than the raw OpenCode id.
    id: clientModelID(model),
    name: clientModelID(model),
    contextWindow: model.input ?? model.context ?? 200000,
    maxTokens: model.output ?? 8192,
    input: model.images ? ['text', 'image'] : ['text'],
  };
}

// Build this app's provider entry, or null when there is nothing to publish.
export function dshProviderEntry(models, endpoint, keyEnv) {
  if (!models.length) return null;
  return {
    id: DSH_ENTRY_ID,
    name: DSH_ENTRY_NAME,
    config: {
      providers: {
        [DSH_PROVIDER_ID]: {
          displayName: 'OW Bridge',
          apiKeyEnv: keyEnv,
          api: 'openai-completions',
          baseURL: endpoint,
          models: models.map(dshModel),
        },
      },
    },
  };
}

// Merge bridged models into a dsh patch document.
// The provider entry is replaced wholesale and the default-model entry is repointed at it, so
// switching models or removing the bridge leaves no dangling references. Every other entry,
// including other providers the user configured, is preserved as written.
export function dshMerge(document, models, endpoint, keyEnv) {
  const entries = Array.isArray(document) ? document : [];
  const providerEntry = dshProviderEntry(models, endpoint, keyEnv);
  // Only this app's own provider entry is removed. A default-model or subagent allow-list entry
  // the user wrote is theirs: repointing it would silently change the model they selected.
  const kept = entries.filter(e => e?.id !== DSH_ENTRY_ID);
  if (!providerEntry) return { document: kept, entries: [], kept };
  // Entries are appended in place, so a user-defined default model that already exists is kept and
  // the bridge provider is simply offered alongside it.
  return { document: [...kept, providerEntry], entries: models, kept };
}

// The name of the environment variable the patch should reference for the API key. dsh reads
// the value from .credentials.yaml, so the key itself is written there, not in the patch.
export const DSH_KEY_ENV = 'OW_BRIDGE_API_KEY';
export const DSH_CREDENTIALS_FILE = '.credentials.yaml';
