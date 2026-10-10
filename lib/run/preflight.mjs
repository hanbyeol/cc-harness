// Run preflight and the security tier a run acts on (SPEC §8).
// ------------------------------------------------------------------ defaults
import { HarnessError } from '../errors.mjs';
import { loadFeatures } from '../state.mjs';
import { loadContract } from '../contract.mjs';
import { RUN_STATUSES } from './common.mjs';

export async function defaultDiagnose(args) {
  const { diagnose } = await import('../commands/doctor.mjs');
  return diagnose(args);
}

/**
 * Run preflight (SPEC §8): the doctor verdict for builder, evaluator and — when a critical
 * feature is in scope — security-reviewer. Throws (exit 2) naming each unusable role and why.
 */
export async function preflight({ config, critical, diagnose = defaultDiagnose }) {
  const roles = ['builder', 'evaluator', ...(critical ? ['security-reviewer'] : [])];
  // Only the role adapters: probing every installed CLI (gemini takes seconds) gains the run nothing.
  const report = await diagnose({ config, rolesOnly: true });
  const bad = roles.map((role) => {
    const r = (report?.roles || []).find((x) => x.role === role);
    if (r?.usable) return null;
    return `${role}${r?.adapter ? ` (${r.adapter})` : ''}: ${r?.reason || 'not reported by doctor'}`;
  }).filter(Boolean);
  if (bad.length) {
    throw new HarnessError(`run preflight failed — role not usable:\n  ${bad.join('\n  ')}\nnothing was started; fix the roles (see \`harness doctor\`) and run again`, { code: 'preflight' });
  }
}

/**
 * The security tier a run acts on (SPEC §8): the approved contract's, not the features.json copy.
 * A feature without a contract keeps its features.json tier. `mismatch` is the features.json
 * tier when it differs from the contract's, else null.
 */
export function effectiveTier(root, feature) {
  let contract;
  try {
    contract = loadContract(root, feature.id).contract;
  } catch (e) {
    if (e instanceof HarnessError && e.code === 'unknown_contract') return { tier: feature.security_tier, mismatch: null };
    throw e;
  }
  const tier = contract.security_tier ?? 'standard';
  const listed = feature.security_tier ?? 'standard';
  return { tier, mismatch: listed !== tier ? listed : null };
}

export const tierWarning = (id, t) => `warning: ${id} security_tier is '${t.mismatch}' in features.json but '${t.tier}' in the approved contract — the run uses the contract's '${t.tier}'`;

// A new run checks the role CLIs before it creates any branch or worktree (SPEC §8).
export async function runPreflight(ctx) {
  const { root, cfg, resume, deps, inScope } = ctx;
  const callsCli = !(deps.build && (deps.evaluate || deps.runAdapter));
  if (!resume && (deps.diagnose || callsCli)) {
    const scoped = loadFeatures(root).features.filter((f) => inScope(f.id) && RUN_STATUSES.includes(f.status));
    if (scoped.length) {
      await preflight({ config: cfg, critical: scoped.some((f) => effectiveTier(root, f).tier === 'critical'), diagnose: deps.diagnose });
    }
  }
}
