// `harness doctor` — detect installed CLIs, verify every flag an adapter would emit is
// listed in that CLI's --help, and report whether each configured role is usable
// (SPEC §10). Never guesses: a missing flag or missing authentication makes the role unusable.
import { runCommand, isNotFound } from '../exec.mjs';
import { isInitialized, paths, readJson } from '../state.mjs';
import { loadConfig, resolveConfig, unknownConfigKeys, unknownKeyText } from '../config.mjs';
import { detectPreset } from '../testcount.mjs';
import {
  ADAPTER_NAMES, getAdapter, resolveRole, roleModel, roleEffort, isReadOnlyRole, missingFlags, resolveInvocation,
} from '../adapters/index.mjs';
import { TIERS } from '../config.mjs';
import { blockStatus, describeStatus } from '../claudemd.mjs';
import { HarnessError } from '../errors.mjs';
import { usageLine } from '../help.mjs';

const CORE_ROLES = ['builder', 'evaluator', 'security-reviewer'];

const whoOf = (w) => `${w.adapter ?? '-'}${w.model ? `/${w.model}` : ''}`;

// The models a role is called with (SPEC §10 role model policy): per tier, and for the
// builder the escalation (round ≥ 2) and merge-conflict models when they are set.
function policyOf(config, role) {
  const value = config.roles?.[role];
  const spec = value && typeof value === 'object' ? value : {};
  const models = {};
  for (const tier of TIERS) models[tier] = roleModel(config, role, { tier }).model;
  if (role === 'builder') {
    if (spec.escalate) models.escalate = spec.escalate;
    if (spec.conflict_model) models.conflict = spec.conflict_model;
  }
  // The model a refused call is asked once more with (F168).
  if (spec.refusal_model) models.refusal = spec.refusal_model;
  return models;
}

// The efforts a role is called with when it sets effort_by_tier or effort_escalate (F167):
// {critical, standard} and, for the builder, escalate (null when unset). Null when it sets
// neither, so the role keeps the single 'effort <value>' line.
function effortPolicyOf(config, role) {
  const value = config.roles?.[role];
  const spec = value && typeof value === 'object' ? value : {};
  if (spec.effort_by_tier === undefined && spec.effort_escalate === undefined) return null;
  const efforts = {};
  for (const tier of TIERS) efforts[tier] = roleEffort(config, role, { tier });
  if (role === 'builder') efforts.escalate = spec.effort_escalate ?? null;
  return efforts;
}

// Runs `<bin> --version` and `<bin> <helpArgs>`. Returns help=null when the CLI is absent.
export async function defaultProbe(adapter) {
  const exec = async (args) => {
    const inv = resolveInvocation(adapter.bin, args);
    if (!inv) return null;
    const r = await runCommand(inv, { cwd: process.cwd(), timeoutSec: 30, inheritEnv: true });
    return isNotFound(r) || r.error || r.timedOut ? null : r;
  };
  if (!adapter.bin) return { installed: false, version: null, help: null };
  const helpArgs = adapter.helpArgs || ['--help'];
  // An adapter with authArgs reports its login without a model call (claude auth status).
  const authOut = async () => {
    if (!adapter.authArgs) return {};
    const a = await exec(adapter.authArgs);
    return { auth: a ? { code: a.code, stdout: a.stdout } : null };
  };
  const v = await exec(['--version']);
  if (v) {
    const h = await exec(helpArgs);
    return {
      installed: true,
      version: (v.stdout || v.stderr).trim().split(/\r?\n/)[0] || 'unknown',
      help: h ? `${h.stdout}\n${h.stderr}` : '',
      ...(await authOut()),
    };
  }
  // --version itself can fail (e.g. it needs network access and times out) on a CLI that
  // is otherwise usable — re-check with --help before giving up on it.
  const h = await exec(helpArgs);
  if (!h) return { installed: false, version: null, help: null };
  return { installed: true, version: 'unknown', help: `${h.stdout}\n${h.stderr}`, ...(await authOut()) };
}

/**
 * @param {{config: object, probe?: (adapter) => Promise<{installed:boolean, version:string|null, help:string|null}>,
 *   env?: object, rolesOnly?: boolean}} p  env feeds the adapters' auth checks (HOME and auth variable names; values are never reported).
 *   rolesOnly probes only the adapters the roles use and reports no CLI list (run preflight).
 */
export async function diagnose({ config, probe = defaultProbe, env = process.env, rolesOnly = false }) {
  const probes = new Map();
  const probeOf = async (name) => {
    if (!probes.has(name)) {
      const adapter = getAdapter(name, config);
      const skip = name === 'generic' && !adapter.configured;
      probes.set(name, skip ? { installed: false, version: null, help: null, unconfigured: true } : await probe(adapter));
    }
    return probes.get(name);
  };
  // Adapters that can tell without a model call whether the CLI is authenticated: gemini from
  // env and settings, claude from the probe's `auth status` output (null = unknown, no block).
  const auths = new Map();
  const authOf = (name) => {
    const adapter = getAdapter(name, config);
    if (!auths.has(name)) {
      if (adapter.authStatus) auths.set(name, adapter.authStatus(env));
      else if (adapter.authFromStatus) auths.set(name, adapter.authFromStatus(probes.get(name)?.auth ?? null));
      else auths.set(name, null);
    }
    return auths.get(name);
  };

  const clis = [];
  for (const name of rolesOnly ? [] : ADAPTER_NAMES) {
    const p = await probeOf(name);
    clis.push({ name, installed: p.installed, version: p.version, experimental: Boolean(getAdapter(name, config).experimental), unconfigured: Boolean(p.unconfigured),
      auth: p.installed ? authOf(name) : null });
  }

  const roleNames = [...CORE_ROLES, ...Object.keys(config.roles || {}).filter((r) => !CORE_ROLES.includes(r))];
  const roles = [];
  for (const role of roleNames) {
    const { adapter: name, model } = resolveRole(config.roles?.[role], config);
    const readOnly = isReadOnlyRole(role);
    const models = policyOf(config, role);
    const effort = roleEffort(config, role);
    const efforts = effortPolicyOf(config, role);
    const entry = { role, adapter: name, model, models, effort, efforts, readOnly, usable: false, reason: null, missing: [] };
    const adapter = name ? getAdapter(name, config) : null;
    if (!adapter) {
      entry.reason = name ? `unknown adapter '${name}'` : 'no adapter assigned';
    } else {
      const p = await probeOf(name);
      if (!p.installed) {
        entry.reason = p.unconfigured ? 'adapters.generic is not configured' : `${adapter.bin} not installed`;
      } else {
        const budgetUsd = config.budget?.step_usd ?? undefined;
        // Any model the policy may pass needs the CLI's model flag.
        const anyModel = model ?? Object.values(models).find(Boolean) ?? null;
        // Any effort a call of the role may pass needs the CLI's effort flag (F167).
        const anyEffort = effort ?? (efforts ? Object.values(efforts).find(Boolean) : null) ?? null;
        entry.missing = missingFlags(p.help, adapter.requiredFlags({ readOnly, schema: readOnly ? {} : undefined, budgetUsd, model: anyModel, effort: anyEffort }));
        const auth = authOf(name);
        if (entry.missing.length) entry.reason = `--help lacks ${entry.missing.join(', ')}`;
        else if (auth && !auth.ok) entry.reason = auth.reason;
        else entry.usable = true;
      }
    }
    roles.push(entry);
  }

  // Per tier: a builder model the tier may use (round 1, escalation, conflict resolution)
  // that is the evaluator's model makes that tier's reviews fresh-context only.
  const sameByTier = TIERS.map((tier) => {
    const ev = roleModel(config, 'evaluator', { tier });
    const same = [
      roleModel(config, 'builder', { tier }),
      roleModel(config, 'builder', { tier, round: 2 }),
      roleModel(config, 'builder', { tier, round: 2, conflict: true }),
    ].find((b) => b.adapter === ev.adapter && (b.model || null) === (ev.model || null));
    return { tier, same };
  });
  // The evaluator's base model only matters through the tiers it is used for (by_tier wins).
  const ind = sameByTier.some((t) => t.same) ? 'fresh-context' : 'cross-model';
  const warnings = [];
  if (sameByTier.every((t) => t.same)) {
    const b = resolveRole(config.roles?.builder, config);
    warnings.push(`builder and evaluator use the same model (${b.adapter}${b.model ? `/${b.model}` : ''}) — `
      + 'independence is fresh-context only; assign the evaluator a different adapter or model for cross-model review');
  }
  for (const { tier, same } of sameByTier) {
    if (same) {
      warnings.push(`fresh-context for ${tier}: builder and evaluator both use ${whoOf(same)} for ${tier} features — `
        + `set roles.evaluator.by_tier.${tier} or the builder's model to a different one for cross-model review`);
    }
  }
  for (const c of clis) if (c.installed && c.experimental) warnings.push(`${c.name} adapter is experimental (flags from docs, not measured)`);
  return { clis, roles, independence: ind, warnings, ok: roles.every((r) => r.usable) };
}

export default async function doctor({ root, args = [], out, err, probe, env }) {
  if (args.length) throw new HarnessError(`unexpected argument '${args[0]}'\n${usageLine('doctor')}`, { code: 'usage' });
  const config = isInitialized(root) ? loadConfig(root) : resolveConfig({});
  const report = await diagnose({ config, probe, env });

  out('CLIs:');
  for (const c of report.clis) {
    const state = c.installed ? c.version : c.unconfigured ? 'not configured' : 'not installed';
    const auth = c.auth ? `  ${c.auth.ok ? `authenticated (${c.auth.via})` : c.auth.reason}` : '';
    out(`  ${c.name.padEnd(8)} ${state}${c.experimental ? '  (experimental)' : ''}${auth}`);
  }
  out('roles:');
  for (const r of report.roles) {
    const who = `${r.adapter ?? '-'}${r.model ? `/${r.model}` : ''}`;
    const mode = r.readOnly ? 'read-only' : 'write';
    out(`  ${r.role.padEnd(18)} ${who.padEnd(16)} ${mode.padEnd(9)} ${r.usable ? 'usable' : `NOT usable: ${r.reason}`}`);
    const m = r.models || {};
    const line = (label, model) => out(`    ${label.padEnd(16)} ${whoOf({ adapter: r.adapter, model })}`);
    for (const tier of TIERS) if (tier in m) line(tier, m[tier]);
    if (r.role === 'builder') {
      if (m.escalate) line('escalate (r≥2)', m.escalate); else out(`    ${'escalate (r≥2)'.padEnd(16)} not set (round 1 model)`);
      if (m.conflict) line('conflict', m.conflict); else out(`    ${'conflict'.padEnd(16)} not set (the round's model)`);
    }
    if (m.refusal) line('refusal', m.refusal);
    // One effort for every call of the role (SPEC §10), or per tier and round (F167).
    if (r.efforts) {
      for (const tier of TIERS) out(`    effort ${tier.padEnd(8)}  ${r.efforts[tier] ?? 'not set'}`);
      if (r.role === 'builder') out(`    effort escalate (r≥2)  ${r.efforts.escalate ?? 'not set (the round 1 effort)'}`);
    } else {
      out(`    effort ${r.effort ?? 'not set'}`);
    }
  }
  out(`independence: ${report.independence}`);
  if (isInitialized(root)) {
    for (const u of unknownConfigKeys(readJson(paths(root).config))) {
      out(`config: ${unknownKeyText(u).replace('unknown config key', 'unknown key')}`);
    }
  }
  out(`language: ${config.language ?? "not set (reply in the user's language)"}`);
  out(`CLAUDE.md block: ${claudeMdLine(root)}`);
  // Only a suggestion: doctor never writes config.json.
  const tc = config.verify?.test_count;
  if (tc) out(`test count: ${tc}`);
  else {
    out('test count: not configured');
    const preset = detectPreset(root);
    if (preset) out(`  suggest: ${preset} (set verify.test_count in .harness/config.json)`);
  }
  for (const w of report.warnings) err(`warning: ${w}`);
  return report.ok ? 0 : 1;
}

// One line on the CLAUDE.md block (SPEC §4.1): current, missing or outdated with the fix,
// or why it cannot be managed (a symbolic link, malformed markers).
function claudeMdLine(root) {
  try {
    const s = blockStatus(root);
    return s.state === 'current' ? describeStatus(s) : `${describeStatus(s)} — run harness claude-md`;
  } catch (e) {
    if (e instanceof HarnessError) return e.message;
    throw e;
  }
}
