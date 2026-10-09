import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, readJson } from './state.mjs';
import { HarnessError } from './errors.mjs';
import { PRESET_NAMES, getPreset, isPresetValue, isFromValue, fromIndex } from './testcount.mjs';
import { isObj as isPlainObject } from './util.mjs';

// Profiles ship with the package (not the user's project), so resolve from here.
export const PROFILES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'profiles');

export const DEFAULTS = Object.freeze({
  profile: 'sdlc',
  base_branch: 'main',
  integration_branch: 'harness/integration',
  protected_branches: ['main'],
  verify: { commands: [], skip_markers: [], test_paths: [], test_count: null, check_parallel: 'auto', vacuity_timeout_sec: 120, flaky: 'retry', cache: 'on' },
  threshold: 7,
  max_rounds: 3,
  budget: { step_timeout_sec: 1800, git_timeout_sec: 300, step_usd: null, run_usd: null },
  run: { max_parallel: 'auto', verify_parallel: 'auto' },
  limits: { ac: 12, sc: 8, es: 8, bytes: 20480 },
  roles: { builder: 'claude', evaluator: 'claude', 'security-reviewer': 'claude' },
  env_allowlist: [],
  secret_globs: [],
  rubric: {},
});

// verify.flaky: what a verify command that failed once and then passed becomes (SPEC §6.1).
export const FLAKY_MODES = Object.freeze(['retry', 'fail']);

// verify.cache: whether a passed verify result is stored and reused (SPEC §6.4).
export const VERIFY_CACHE_MODES = Object.freeze(['on', 'off']);

// How many features `harness run` may work on at once (SPEC §8.10).
export const isMaxParallel = (v) => Number.isInteger(v) && v >= 1;
// A run.max_parallel / run.verify_parallel / verify.check_parallel setting: a positive integer
// or 'auto' (SPEC §6.3, §8.10).
export const isParallelSetting = (v) => v === 'auto' || isMaxParallel(v);

// Time limit of each git command the core runs for itself (worktrees, diff, merge, refs),
// separate from budget.step_timeout_sec, which bounds the user's commands (SPEC §6.3).
export const gitTimeoutOf = (config) => config?.budget?.git_timeout_sec ?? DEFAULTS.budget.git_timeout_sec;

// The round limit of a feature: config.max_rounds when it is a positive integer, otherwise 3.
export const maxRoundsOf = (config) => {
  const n = config?.max_rounds;
  return Number.isInteger(n) && n > 0 ? n : DEFAULTS.max_rounds;
};

// setTimeout's delay argument must fit a 32-bit signed integer (2147483647 ms) or Node clamps
// it to 1ms — a timeout config value at or above that many seconds would silently misbehave.
const MAX_TIMEOUT_SEC = 2147483;
const isValidTimeoutSec = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= MAX_TIMEOUT_SEC;

export const availableCpus = () => (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);

// The conversation language (SPEC §4): two lowercase letters, optionally '-' and two
// uppercase letters ('ko', 'pt-BR'). Optional; there is no default.
export const isLanguage = (v) => typeof v === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(v);

// Security tiers a role can name a model for (roles.<role>.by_tier, SPEC §10).
export const TIERS = Object.freeze(['critical', 'standard']);

// Effort levels a role can set (roles.<role>.effort, SPEC §4, §10): the values `claude --help`
// lists for --effort. Only the claude adapter passes it on.
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const isEffort = (v) => EFFORTS.includes(v);

// roles.<role>.effort: one of EFFORTS, and only on a role whose adapter is claude.
function validateEfforts(user, label) {
  if (!isPlainObject(user.roles)) return;
  for (const [role, v] of Object.entries(user.roles)) {
    if (!isPlainObject(v) || v.effort === undefined) continue;
    const key = `roles.${role}.effort`;
    if (!isEffort(v.effort)) {
      throw new HarnessError(`${label}: '${key}' must be one of ${EFFORTS.join(', ')}, got ${JSON.stringify(v.effort)}`, { code: 'config_invalid' });
    }
    if (v.adapter !== 'claude') {
      throw new HarnessError(`${label}: '${key}' is only supported by the claude adapter, got adapter ${JSON.stringify(v.adapter ?? null)}`, { code: 'config_invalid' });
    }
  }
}

// A model value becomes one argument after --model / -m (SR-1): a leading '-' would be read
// as another flag, whitespace or control characters could split or corrupt the argument on
// the Windows command line.
const UNSAFE_MODEL = /^-|[\s\p{Cc}\p{Cf}]/u;
export const isSafeModel = (v) => typeof v === 'string' && v !== '' && !UNSAFE_MODEL.test(v);

// Every model value in roles.* and adapters.*.model (SPEC §10 role model policy).
function validateModels(user, label) {
  const bad = (key, why, value) => {
    throw new HarnessError(`${label}: '${key}' ${why}, got ${JSON.stringify(value)}`, { code: 'config_invalid' });
  };
  // `optional`: '' means unset (roles.<role>.model, adapters.<name>.model fall back).
  const check = (key, value, { optional = false } = {}) => {
    if (typeof value !== 'string' || (value === '' && !optional)) bad(key, 'must be a non-empty string', value);
    if (value !== '' && !isSafeModel(value)) bad(key, 'must not start with \'-\' or contain whitespace or control characters', value);
  };
  if (isPlainObject(user.roles)) {
    for (const [role, v] of Object.entries(user.roles)) {
      if (!isPlainObject(v)) continue;
      const at = `roles.${role}`;
      if (v.model !== undefined && v.model !== null) check(`${at}.model`, v.model, { optional: true });
      if (v.by_tier !== undefined) {
        if (!isPlainObject(v.by_tier)) bad(`${at}.by_tier`, `must be an object with keys ${TIERS.join(', ')}`, v.by_tier);
        for (const [tier, m] of Object.entries(v.by_tier)) {
          if (!TIERS.includes(tier)) bad(`${at}.by_tier.${tier}`, `is not a security tier (${TIERS.join(', ')})`, m);
          check(`${at}.by_tier.${tier}`, m);
        }
      }
      for (const key of ['escalate', 'conflict_model']) {
        if (v[key] !== undefined) check(`${at}.${key}`, v[key]);
      }
    }
  }
  if (isPlainObject(user.adapters)) {
    for (const [name, a] of Object.entries(user.adapters)) {
      if (isPlainObject(a) && a.model !== undefined && a.model !== null) check(`adapters.${name}.model`, a.model, { optional: true });
    }
  }
}

// Objects merge key by key; arrays and scalars from `over` replace `base`.
export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? structuredClone(base) : structuredClone(over);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

// A profile name is a file name stem: a path separator or '..' would reach outside
// profiles/ (and templates/, SPEC §4.1), so such a name is never a profile.
export const isProfileName = (name) => typeof name === 'string' && name !== '' && !/[\\/]/.test(name) && !name.includes('..');

export function listProfiles() {
  try {
    return fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter(isProfileName).sort();
  } catch {
    return [];
  }
}

// A profile contributes defaults (verify commands, rubric); `name` and
// `description` describe the file itself and are not config keys.
export function loadProfile(name) {
  const available = listProfiles();
  if (!isProfileName(name) || !available.includes(name)) {
    throw new HarnessError(`unknown profile '${name}'. Available profiles: ${available.join(', ')}`, { code: 'unknown_profile' });
  }
  const { name: _n, description: _d, ...rest } = readJson(path.join(PROFILES_DIR, `${name}.json`));
  return rest;
}

// Shape checks on the user's file: a wrong type here would otherwise surface
// later as a TypeError (internal error) or silently fall back to defaults.
// Keys whose default is an object must stay objects when set.
export function validateUser(user, label) {
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
    ['verify.test_paths', verify.test_paths],
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
  for (const key of ['max_parallel', 'verify_parallel']) {
    const value = user.run?.[key];
    if (value !== undefined && !isParallelSetting(value)) {
      throw new HarnessError(`${label}: 'run.${key}' must be 'auto' or an integer ≥ 1, got ${JSON.stringify(value)}`, { code: 'config_invalid' });
    }
  }
  if (verify.check_parallel !== undefined && !isParallelSetting(verify.check_parallel)) {
    throw new HarnessError(`${label}: 'verify.check_parallel' must be 'auto' or an integer ≥ 1, got ${JSON.stringify(verify.check_parallel)}`, { code: 'config_invalid' });
  }
  const stepTimeout = user.budget?.step_timeout_sec;
  if (stepTimeout !== undefined && !isValidTimeoutSec(stepTimeout)) {
    throw new HarnessError(`${label}: 'budget.step_timeout_sec' must be a number of seconds between 1 and ${MAX_TIMEOUT_SEC}, got ${JSON.stringify(stepTimeout)}`, { code: 'config_invalid' });
  }
  const gitTimeout = user.budget?.git_timeout_sec;
  if (gitTimeout !== undefined && !isValidTimeoutSec(gitTimeout)) {
    throw new HarnessError(`${label}: 'budget.git_timeout_sec' must be a number of seconds between 1 and ${MAX_TIMEOUT_SEC}, got ${JSON.stringify(gitTimeout)}`, { code: 'config_invalid' });
  }
  if (verify.flaky !== undefined && !FLAKY_MODES.includes(verify.flaky)) {
    throw new HarnessError(`${label}: 'verify.flaky' must be 'retry' or 'fail', got ${JSON.stringify(verify.flaky)}`, { code: 'config_invalid' });
  }
  if (verify.cache !== undefined && !VERIFY_CACHE_MODES.includes(verify.cache)) {
    throw new HarnessError(`${label}: 'verify.cache' must be 'on' or 'off', got ${JSON.stringify(verify.cache)}`, { code: 'config_invalid' });
  }
  if (verify.vacuity_timeout_sec !== undefined && !isValidTimeoutSec(verify.vacuity_timeout_sec)) {
    throw new HarnessError(`${label}: 'verify.vacuity_timeout_sec' must be a number of seconds between 1 and ${MAX_TIMEOUT_SEC}, got ${JSON.stringify(verify.vacuity_timeout_sec)}`, { code: 'config_invalid' });
  }
  if (user.language !== undefined && !isLanguage(user.language)) {
    throw new HarnessError(`${label}: 'language' must be a language code such as 'ko', 'en' or 'pt-BR', got ${JSON.stringify(user.language)}`, { code: 'config_invalid' });
  }
  validateModels(user, label);
  validateEfforts(user, label);
  if (verify.test_count !== undefined && verify.test_count !== null && typeof verify.test_count !== 'string') {
    throw new HarnessError(`${label}: 'verify.test_count' must be a string or null, got ${JSON.stringify(verify.test_count)}`, { code: 'config_invalid' });
  }
  // A 'preset:' value must name a preset exactly; it is never run as a shell command.
  if (isPresetValue(verify.test_count) && !getPreset(verify.test_count)) {
    throw new HarnessError(`${label}: 'verify.test_count' has unknown preset ${JSON.stringify(verify.test_count)}. Available presets: ${PRESET_NAMES.join(', ')}`, { code: 'config_invalid' });
  }
  if (isFromValue(verify.test_count) && fromIndex(verify.test_count) === null) {
    throw new HarnessError(`${label}: 'verify.test_count' ${JSON.stringify(verify.test_count)} must be exactly 'from:commands[<index>]'`, { code: 'config_invalid' });
  }
  // The index is checked against the file's own commands here, and against the merged
  // commands (a profile may supply them) in resolveConfig.
  if (Array.isArray(verify.commands)) checkFromIndex(verify, label);
}

// 'from:commands[i]' must name an existing verify.commands entry.
function checkFromIndex(verify, label) {
  const i = fromIndex(verify?.test_count);
  if (i === null) return;
  const n = Array.isArray(verify.commands) ? verify.commands.length : 0;
  if (i >= n) {
    throw new HarnessError(`${label}: 'verify.test_count' ${JSON.stringify(verify.test_count)} refers to verify.commands[${i}], but verify.commands has ${n} entr${n === 1 ? 'y' : 'ies'}`, { code: 'config_invalid' });
  }
}

// DEFAULTS ← profile ← user config (user wins).
export function resolveConfig(user = {}, { label = 'config' } = {}) {
  validateUser(user, label);
  const profile = loadProfile(user.profile ?? DEFAULTS.profile);
  const merged = deepMerge(deepMerge(DEFAULTS, profile), user);
  checkFromIndex(merged.verify, label);
  return merged;
}

export function loadConfig(root) {
  const file = paths(root).config;
  return resolveConfig(readJson(file), { label: file });
}
