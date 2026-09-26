// `harness doctor` — detect installed CLIs, verify every flag an adapter would emit is
// listed in that CLI's --help, and report whether each configured role is usable
// (SPEC §10). Never guesses: a missing flag or missing authentication makes the role unusable.
import { runCommand, isNotFound } from '../exec.mjs';
import { isInitialized } from '../state.mjs';
import { loadConfig, resolveConfig } from '../config.mjs';
import { detectPreset } from '../testcount.mjs';
import {
  ADAPTER_NAMES, getAdapter, resolveRole, roleModel, independence, isReadOnlyRole, missingFlags, resolveInvocation,
} from '../adapters/index.mjs';
import { TIERS } from '../config.mjs';

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
  return models;
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
  const v = await exec(['--version']);
  if (!v) return { installed: false, version: null, help: null };
  const h = await exec(adapter.helpArgs || ['--help']);
  return {
    installed: true,
    version: (v.stdout || v.stderr).trim().split(/\r?\n/)[0] || 'unknown',
    help: h ? `${h.stdout}\n${h.stderr}` : '',
  };
}

/**
 * @param {{config: object, probe?: (adapter) => Promise<{installed:boolean, version:string|null, help:string|null}>,
 *   env?: object}} p  env feeds the adapters' auth checks (HOME and auth variable names; values are never reported)
 */
export async function diagnose({ config, probe = defaultProbe, env = process.env }) {
  const probes = new Map();
  const probeOf = async (name) => {
    if (!probes.has(name)) {
      const adapter = getAdapter(name, config);
      const skip = name === 'generic' && !adapter.configured;
      probes.set(name, skip ? { installed: false, version: null, help: null, unconfigured: true } : await probe(adapter));
    }
    return probes.get(name);
  };
  // Adapters that can tell without a model call whether the CLI is authenticated (gemini).
  const auths = new Map();
  const authOf = (name) => {
    const adapter = getAdapter(name, config);
    if (!adapter.authStatus) return null;
    if (!auths.has(name)) auths.set(name, adapter.authStatus(env));
    return auths.get(name);
  };

  const clis = [];
  for (const name of ADAPTER_NAMES) {
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
    const entry = { role, adapter: name, model, models, readOnly, usable: false, reason: null, missing: [] };
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
        entry.missing = missingFlags(p.help, adapter.requiredFlags({ readOnly, schema: readOnly ? {} : undefined, budgetUsd, model: anyModel }));
        const auth = authOf(name);
        if (entry.missing.length) entry.reason = `--help lacks ${entry.missing.join(', ')}`;
        else if (auth && !auth.ok) entry.reason = auth.reason;
        else entry.usable = true;
      }
    }
    roles.push(entry);
  }

  const ind = independence(config.roles || {}, config);
  const warnings = [];
  if (ind === 'fresh-context') {
    const b = resolveRole(config.roles?.builder, config);
    warnings.push(`builder and evaluator use the same model (${b.adapter}${b.model ? `/${b.model}` : ''}) — `
      + 'independence is fresh-context only; assign the evaluator a different adapter or model for cross-model review');
  }
  // Per tier: a builder model the tier may use (round 1, escalation, conflict resolution)
  // that is the evaluator's model makes that tier's reviews fresh-context only.
  for (const tier of TIERS) {
    const ev = roleModel(config, 'evaluator', { tier });
    const same = [
      roleModel(config, 'builder', { tier }),
      roleModel(config, 'builder', { tier, round: 2 }),
      roleModel(config, 'builder', { tier, round: 2, conflict: true }),
    ].find((b) => b.adapter === ev.adapter && (b.model || null) === (ev.model || null));
    if (same) {
      warnings.push(`fresh-context for ${tier}: builder and evaluator both use ${whoOf(same)} for ${tier} features — `
        + `set roles.evaluator.by_tier.${tier} or the builder's model to a different one for cross-model review`);
    }
  }
  for (const c of clis) if (c.installed && c.experimental) warnings.push(`${c.name} adapter is experimental (flags from docs, not measured)`);
  return { clis, roles, independence: ind, warnings, ok: roles.every((r) => r.usable) };
}

export default async function doctor({ root, out, err, probe, env }) {
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
  }
  out(`independence: ${report.independence}`);
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
