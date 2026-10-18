// Worktree setup (SPEC §8): config run.worktree_setup runs once in the project directory of a
// newly created feature or integration worktree, before its first build or merge.
import { runCommand, filteredEnv } from '../exec.mjs';
import { recordEvent } from '../events.mjs';
import { Interrupted, SetupStop } from './common.mjs';
import { dirtyPaths } from './worktree.mjs';

const MAX_SHOWN = 2000; // characters of a failed command's output kept in the stop
const MAX_PATHS = 10;

export const setupCommands = (cfg) => (Array.isArray(cfg.run?.worktree_setup) ? cfg.run.worktree_setup : []);

// Runs the commands in `cwd` (the project directory inside worktree `wt`). `name` is a feature id
// or 'integration'. Throws SetupStop on a failure and Interrupted when the run was interrupted.
export async function runWorktreeSetup(ctx, { name, wt, cwd }) {
  const { root, d, cfg, g, signal, stepTimeout, redact, save, state } = ctx;
  const commands = setupCommands(cfg);
  if (!commands.length) return;
  const env = filteredEnv(cfg.env_allowlist ?? [], d.env);
  const started = d.monotonic();
  let outcome = 'ok';
  let info = null;
  for (const command of commands) {
    const r = await runCommand(command, { cwd, timeoutSec: stepTimeout, env, signal, killDetached: true });
    if (r.aborted) throw new Interrupted();
    if (r.timedOut) {
      outcome = 'timeout';
      info = { command, reason: `timed out after ${stepTimeout}s` };
    } else if (r.code !== 0) {
      outcome = 'fail';
      info = { command, reason: r.error && r.code === null ? `could not start (${r.error})` : `exit ${r.code ?? r.signal}` };
    }
    if (info) {
      info.output = redact(`${r.stdout}${r.stderr}`).trim().slice(-MAX_SHOWN);
      break;
    }
  }
  if (!info) {
    // Files the commands left must be ignored: a tracked change or a visible new file would be
    // committed as the feature's work (or block the merge).
    const dirty = await dirtyPaths(g, wt);
    if (dirty.length) {
      outcome = 'fail';
      const shown = dirty.slice(0, MAX_PATHS).join(', ');
      info = {
        command: commands[commands.length - 1],
        reason: `left files git does not ignore: ${shown}${dirty.length > MAX_PATHS ? ` (+${dirty.length - MAX_PATHS} more)` : ''} — add them to .gitignore`,
        output: '',
      };
    }
  }
  const ms = Math.max(0, Math.round(d.monotonic() - started));
  (state.worktreeSetups ??= []).push({ worktree: name, commands: commands.length, outcome, ms });
  recordEvent(root, {
    stage: 'build', type: 'worktree_setup', feature: name === 'integration' ? undefined : name,
    data: { worktree: name, commands: commands.length, outcome, ms },
  }, { config: cfg, redact, warn: d.warn });
  save();
  if (info) {
    const err = new SetupStop(name === 'integration' ? null : name, { worktree: name, dir: wt, ...info });
    ctx.envStop = ctx.envStop ?? err;
    throw err;
  }
}
