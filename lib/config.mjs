import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, readJson } from './state.mjs';
import { HarnessError } from './errors.mjs';

// Profiles ship with the package (not the user's project), so resolve from here.
export const PROFILES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'profiles');

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
  rubric: {},
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

export function listProfiles() {
  try {
    return fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

// A profile contributes defaults (verify commands, rubric); `name` and
// `description` describe the file itself and are not config keys.
export function loadProfile(name) {
  const available = listProfiles();
  if (typeof name !== 'string' || !available.includes(name)) {
    throw new HarnessError(`unknown profile '${name}'. Available profiles: ${available.join(', ')}`, { code: 'unknown_profile' });
  }
  const { name: _n, description: _d, ...rest } = readJson(path.join(PROFILES_DIR, `${name}.json`));
  return rest;
}

// Shape checks on the user's file: a wrong type here would otherwise surface
// later as a TypeError (internal error) or silently fall back to defaults.
// Keys whose default is an object must stay objects when set.
function validateUser(user, label) {
  if (!isPlainObject(user)) {
    const kind = user === null ? 'null' : Array.isArray(user) ? 'an array' : typeof user;
    throw new HarnessError(`${label}: expected a JSON object, got ${kind}`, { code: 'config_invalid' });
  }
  for (const [key, def] of Object.entries(DEFAULTS)) {
    if (isPlainObject(def) && Object.hasOwn(user, key) && !isPlainObject(user[key])) {
      throw new HarnessError(`${label}: '${key}' must be an object, got ${JSON.stringify(user[key])}`, { code: 'config_invalid' });
    }
  }
  // List keys: a string would be iterated character by character (verify.commands) or
  // silently ignored (protected_branches: "v2" leaves only main protected). Empty strings
  // are rejected too: every consumer skips them, so an empty entry is always a mistake.
  const verify = user.verify ?? {};
  const lists = [
    ['verify.commands', verify.commands],
    ['verify.skip_markers', verify.skip_markers],
    ['env_allowlist', user.env_allowlist],
    ['secret_globs', user.secret_globs],
    ['protected_branches', user.protected_branches],
  ];
  for (const [name, value] of lists) {
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw new HarnessError(`${label}: '${name}' must be an array of non-empty strings, got ${JSON.stringify(value)}`, { code: 'config_invalid' });
    }
    value.forEach((el, i) => {
      if (typeof el !== 'string' || el === '') {
        throw new HarnessError(`${label}: '${name}[${i}]' must be a non-empty string, got ${JSON.stringify(el)}`, { code: 'config_invalid' });
      }
    });
  }
  if (verify.test_count !== undefined && verify.test_count !== null && typeof verify.test_count !== 'string') {
    throw new HarnessError(`${label}: 'verify.test_count' must be a string or null, got ${JSON.stringify(verify.test_count)}`, { code: 'config_invalid' });
  }
}

// DEFAULTS ← profile ← user config (user wins).
export function resolveConfig(user = {}, { label = 'config' } = {}) {
  validateUser(user, label);
  const profile = loadProfile(user.profile ?? DEFAULTS.profile);
  return deepMerge(deepMerge(DEFAULTS, profile), user);
}

export function loadConfig(root) {
  const file = paths(root).config;
  return resolveConfig(readJson(file), { label: file });
}
