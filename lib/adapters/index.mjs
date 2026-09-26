// Adapter registry, role resolution and independence classification (SPEC §7.5, §10).
import claude from './claude.mjs';
import gemini from './gemini.mjs';
import codex from './codex.mjs';
import { createGenericAdapter } from './generic.mjs';
import { isSafeModel } from '../config.mjs';
import { HarnessError } from '../errors.mjs';

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

const setModel = (v) => (typeof v === 'string' && v ? v : null);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The adapter and model a role is called with (SPEC §10 role model policy). In order:
 * builder merge-conflict resolution → roles.builder.conflict_model; builder round ≥ 2 of a
 * contract → roles.builder.escalate; then roles.<role>.by_tier.<tier>, roles.<role>.model,
 * adapters.<adapter>.model, null (the CLI's default). A conflict resolution without
 * conflict_model uses the model of its round. An unsafe model value is refused, never passed on.
 * @param {{tier?:string, round?:number, conflict?:boolean}} at
 * @returns {{adapter: string|null, model: string|null}}
 */
export function roleModel(config, role, { tier, round = 1, conflict = false } = {}) {
  const value = config?.roles?.[role];
  const base = resolveRole(value, config);
  const spec = isObj(value) ? value : {};
  let model = setModel(isObj(spec.by_tier) ? spec.by_tier[tier === 'critical' ? 'critical' : 'standard'] : null) ?? base.model;
  if (role === 'builder') {
    if (round >= 2 && setModel(spec.escalate)) model = spec.escalate;
    if (conflict && setModel(spec.conflict_model)) model = spec.conflict_model;
  }
  if (model !== null && !isSafeModel(model)) {
    throw new HarnessError(`roles.${role}: model ${JSON.stringify(model)} must not start with '-' or contain whitespace or control characters`, { code: 'config_invalid' });
  }
  return { adapter: base.adapter, model };
}

/**
 * Every builder model a feature of `tier` used up to contract round `round`: the round-1
 * model, the escalation model from round 2 on, and the conflict model after a resolution.
 */
export function builderModels(config, { tier, round = 1, conflict = false } = {}) {
  const out = [roleModel(config, 'builder', { tier, round: 1 })];
  if (round >= 2) out.push(roleModel(config, 'builder', { tier, round }));
  if (conflict) out.push(roleModel(config, 'builder', { tier, round, conflict: true }));
  return out;
}

const sameModel = (a, b) => a.adapter === b.adapter && (a.model || null) === (b.model || null);

/**
 * 'fresh-context' when any builder model the feature used is the evaluator's model (same
 * adapter, same model — two unset models count as the same), otherwise 'cross-model'.
 */
export function independenceOf(builders, evaluator) {
  return builders.some((b) => sameModel(b, evaluator)) ? 'fresh-context' : 'cross-model';
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
