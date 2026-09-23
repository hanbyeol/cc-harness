// Adapter registry, role resolution and independence classification (SPEC §7.5, §10).
import claude from './claude.mjs';
import gemini from './gemini.mjs';
import codex from './codex.mjs';
import { createGenericAdapter } from './generic.mjs';

export { extractJson, parseOutput, resolveInvocation, missingFlags } from './common.mjs';

export const ADAPTER_NAMES = Object.freeze(['claude', 'gemini', 'codex', 'generic']);

// Roles that must run read-only (SR-6). Everything else (builder) may write.
export const READ_ONLY_ROLES = Object.freeze(['evaluator', 'security-reviewer']);
export const isReadOnlyRole = (role) => READ_ONLY_ROLES.includes(role);

export function getAdapter(name, config = {}) {
  switch (name) {
    case 'claude': return claude;
    case 'gemini': return gemini;
    case 'codex': return codex;
    case 'generic': return createGenericAdapter(config);
    default: return null;
  }
}

/**
 * A role assignment in config.roles is either an adapter name ("claude") or
 * {"adapter": "claude", "model": "opus"}. A missing model falls back to
 * config.adapters.<name>.model, then null (the CLI's own default).
 * @returns {{adapter: string|null, model: string|null}}
 */
export function resolveRole(value, config = {}) {
  let adapter = null;
  let model = null;
  if (typeof value === 'string') adapter = value;
  else if (value && typeof value === 'object') {
    adapter = typeof value.adapter === 'string' ? value.adapter : null;
    model = typeof value.model === 'string' && value.model ? value.model : null;
  }
  if (!model && adapter) {
    const m = config?.adapters?.[adapter]?.model;
    if (typeof m === 'string' && m) model = m;
  }
  return { adapter, model };
}

/**
 * 'cross-model' when builder and evaluator differ in adapter or model, otherwise
 * 'fresh-context' (same model, separate session). Two unset models on the same adapter
 * count as the same model.
 */
export function independence(roles = {}, config = {}) {
  const b = resolveRole(roles.builder, config);
  const e = resolveRole(roles.evaluator, config);
  return b.adapter !== e.adapter || (b.model || null) !== (e.model || null) ? 'cross-model' : 'fresh-context';
}
