// `harness doctor` — detect installed CLIs, verify every flag an adapter would emit is
// listed in that CLI's --help, and report whether each configured role is usable
// (SPEC §10). Never guesses: a missing flag or missing authentication makes the role unusable.
import { runCommand, isNotFound } from '../exec.mjs';
import { isInitialized } from '../state.mjs';
import { loadConfig, resolveConfig } from '../config.mjs';
import {
  ADAPTER_NAMES, getAdapter, resolveRole, independence, isReadOnlyRole, missingFlags, resolveInvocation,
} from '../adapters/index.mjs';

const CORE_ROLES = ['builder', 'evaluator', 'security-reviewer'];

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
    const entry = { role, adapter: name, model, readOnly, usable: false, reason: null, missing: [] };
    const adapter = name ? getAdapter(name, config) : null;
    if (!adapter) {
      entry.reason = name ? `unknown adapter '${name}'` : 'no adapter assigned';
    } else {
      const p = await probeOf(name);
      if (!p.installed) {
        entry.reason = p.unconfigured ? 'adapters.generic is not configured' : `${adapter.bin} not installed`;
      } else {
        const budgetUsd = config.budget?.step_usd ?? undefined;
        entry.missing = missingFlags(p.help, adapter.requiredFlags({ readOnly, schema: readOnly ? {} : undefined, budgetUsd, model }));
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
  }
  out(`independence: ${report.independence}`);
  for (const w of report.warnings) err(`warning: ${w}`);
  return report.ok ? 0 : 1;
}
