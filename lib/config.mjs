import { paths, readJson } from './state.mjs';

export const DEFAULTS = Object.freeze({
  profile: 'sdlc',
  base_branch: 'main',
  integration_branch: 'harness/integration',
  protected_branches: ['main'],
  verify: { commands: [], skip_markers: [], test_count: null },
  threshold: 7,
  max_rounds: 3,
  budget: { step_timeout_sec: 1800, step_usd: null, run_usd: null },
  limits: { ac: 12, sc: 8, es: 8, bytes: 20480 },
  roles: { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' },
  env_allowlist: [],
  secret_globs: [],
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Objects merge key by key; arrays and scalars from `over` replace `base`.
export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? structuredClone(base) : structuredClone(over);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

export function resolveConfig(user = {}) {
  return deepMerge(DEFAULTS, user);
}

export function loadConfig(root) {
  return resolveConfig(readJson(paths(root).config));
}
