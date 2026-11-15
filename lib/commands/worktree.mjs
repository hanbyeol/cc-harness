// `harness worktree add|list|prune`: worktrees for parallel work live inside the project
// (.harness/wt/<name>); merged, clean ones are removed (SPEC §8.12).
import fs from 'node:fs';
import path from 'node:path';
import { HarnessError } from '../errors.mjs';
import { loadConfig, gitTimeoutOf } from '../config.mjs';
import { HARNESS_DIR } from '../state.mjs';
import { usageLine } from '../help.mjs';
import { git, gitCause, dirtyPaths, protectedSet, foldBranch } from '../run/worktree.mjs';
import { realResolve, within } from '../run/wtdir.mjs';

const usage = (msg) => new HarnessError(`${msg}\n${usageLine('worktree')}`, { code: 'usage' });
const fail = (msg, code = 'worktree') => new HarnessError(msg, { code, exit: 1 });

const defaultRun = (cfg, timeoutSec = gitTimeoutOf(cfg)) => (args, cwd) => git(args, cwd, { timeoutSec });

// Windows device names: a directory with one of these names cannot be created.
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

// A worktree name: one path component of [A-Za-z0-9._-], not starting with '-', not only dots,
// not ending with '.' (Windows drops trailing dots), not a Windows device name.
export function validName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith('-')
    && !/^\.+$/.test(name) && !name.endsWith('.') && !DEVICE.test(name);
}

async function topOf(run, root) {
  const r = await run(['rev-parse', '--show-toplevel'], root);
  if (r.code !== 0) throw fail(`not a git repository: ${gitCause(r)}`, 'git');
  return path.resolve(r.stdout.trim());
}

// [{path, head, branch (short name or null), locked, bare}] from `git worktree list --porcelain`.
async function registered(run, cwd) {
  const r = await run(['worktree', 'list', '--porcelain'], cwd);
  if (r.code !== 0) throw fail(`git worktree list failed: ${gitCause(r)}`, 'git');
  const list = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const cur = list.at(-1);
    if (line.startsWith('worktree ')) list.push({ path: path.resolve(line.slice('worktree '.length)), branch: null, locked: false, bare: false });
    else if (!cur) continue;
    else if (line.startsWith('branch refs/heads/')) cur.branch = line.slice('branch refs/heads/'.length);
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
    else if (line === 'bare') cur.bare = true;
  }
  return list;
}

async function localBranch(run, cwd, branch) {
  const r = await run(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
  return r.code === 0;
}

// A branch whose reflog has at most one entry (only its creation) has had no work on it yet;
// an unreadable reflog counts as fresh too, so the worktree is kept.
async function freshBranch(run, cwd, branch) {
  const r = await run(['reflog', 'show', '--format=%H', `refs/heads/${branch}`, '--'], cwd);
  if (r.code !== 0) return true;
  return r.stdout.split(/\r?\n/).filter((l) => l.trim()).length <= 1;
}

/**
 * Every registered worktree with its state — main, detached, protected, locked, dirty, fresh,
 * unmerged, current or prunable, the first that applies — and whether it lies outside the
 * project top. `current`: a worktree that would be prunable but contains `cwd`.
 * Returns {top, base, baseFound, worktrees}.
 */
export async function inspectWorktrees({ root, cfg, run = defaultRun(cfg), cwd = process.cwd() }) {
  const top = await topOf(run, root);
  const base = cfg.base_branch;
  const baseFound = typeof base === 'string' && base !== '' && await localBranch(run, root, base);
  const prot = protectedSet(cfg);
  const special = [base, cfg.integration_branch].filter((b) => typeof b === 'string' && b).map(foldBranch);
  const topReal = realResolve(top);
  const cwdReal = realResolve(path.resolve(cwd));
  const worktrees = [];
  for (const [i, w] of (await registered(run, root)).entries()) {
    const exists = fs.existsSync(w.path);
    const outside = !within(topReal, realResolve(w.path));
    let state;
    if (i === 0 || w.bare) state = 'main';
    else if (!w.branch) state = 'detached';
    else if (prot.has(w.branch) || special.includes(foldBranch(w.branch))) state = 'protected';
    else if (w.locked) state = 'locked';
    else if (exists && (await dirtyPaths(run, w.path)).length) state = 'dirty';
    else if (await freshBranch(run, root, w.branch)) state = 'fresh';
    else if (!baseFound) state = 'unmerged';
    else {
      const a = await run(['merge-base', '--is-ancestor', `refs/heads/${w.branch}`, `refs/heads/${base}`], root);
      if (a.code !== 0) state = 'unmerged';
      else state = within(realResolve(w.path), cwdReal) ? 'current' : 'prunable';
    }
    worktrees.push({ ...w, exists, outside, state });
  }
  return { top, base, baseFound, worktrees };
}

// {prunable, outside} counts for `status --brief`; null when they cannot be worked out.
export async function worktreeCounts(root, cfg) {
  try {
    const { worktrees } = await inspectWorktrees({ root, cfg, run: defaultRun(cfg, 10) });
    return {
      prunable: worktrees.filter((w) => w.state === 'prunable').length,
      outside: worktrees.filter((w) => w.outside).length,
    };
  } catch {
    return null;
  }
}

/**
 * Removes every prunable worktree (`git worktree remove`, never --force), then its branch
 * (`git branch -d`, never -D), then `git worktree prune`. Returns the exit code.
 */
export async function pruneWorktrees({ root, cfg, run = defaultRun(cfg), out, err, dryRun = false }) {
  const { base, baseFound, worktrees } = await inspectWorktrees({ root, cfg, run });
  if (!baseFound) throw fail(`base branch ${base} not found`);
  const targets = worktrees.filter((w) => w.state === 'prunable');
  if (dryRun) {
    for (const w of targets) out(`would remove ${w.path}`);
    return 0;
  }
  let code = 0;
  const warn = (msg) => { err(`harness: warning: ${msg}`); code = 1; };
  const deleteBranch = async (w) => {
    const d = await run(['branch', '-d', w.branch], root);
    if (d.code !== 0) warn(`${w.path}: branch ${w.branch} kept: ${gitCause(d)}`);
  };
  const stale = [];
  for (const w of targets) {
    if (!w.exists) {
      // A registration whose directory is gone: `git worktree prune` below removes it.
      stale.push(w);
      continue;
    }
    const r = await run(['worktree', 'remove', w.path], root);
    if (r.code !== 0) {
      warn(`${w.path} not removed (branch ${w.branch} kept): ${gitCause(r)}`);
      continue;
    }
    out(`removed ${w.path}`);
    await deleteBranch(w);
  }
  const p = await run(['worktree', 'prune'], root);
  if (p.code !== 0) {
    warn(`git worktree prune failed: ${gitCause(p)}`);
    return code;
  }
  for (const w of stale) {
    out(`removed ${w.path}`);
    await deleteBranch(w);
  }
  return code;
}

async function add({ root, cfg, args, out, run = defaultRun(cfg) }) {
  let name;
  let branch;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--branch') {
      branch = args[i + 1];
      if (branch === undefined) throw usage('--branch needs a value');
      i += 1;
    } else if (name === undefined && (!a.startsWith('-') || a === '')) name = a;
    else throw usage(`unexpected argument ${JSON.stringify(a)}`);
  }
  if (name === undefined) throw usage('worktree add needs a name');
  if (!validName(name)) {
    throw usage(`invalid worktree name ${JSON.stringify(name)}: use one path component of letters, digits, '.', '_' and '-', not starting with '-'`);
  }
  branch ??= name;
  if (branch === '' || branch.startsWith('-')) throw usage(`invalid branch name ${JSON.stringify(branch)}`);
  const ref = await run(['check-ref-format', '--branch', branch], root);
  if (ref.code !== 0) throw usage(`invalid branch name ${JSON.stringify(branch)}`);
  await topOf(run, root);
  const dir = path.join(path.resolve(root), HARNESS_DIR, 'wt', name);
  let exists = true;
  try { fs.lstatSync(dir); } catch { exists = false; }
  if (exists) throw fail(`${dir} already exists`);
  if (await localBranch(run, root, branch)) throw fail(`branch ${branch} already exists`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = await run(['worktree', 'add', '-b', branch, dir, 'HEAD'], root);
  if (r.code !== 0) throw fail(`git worktree add failed: ${gitCause(r)}`, 'git');
  out(dir);
  return 0;
}

async function list({ root, cfg, args, out }) {
  if (args.length) throw usage(`unexpected argument ${JSON.stringify(args[0])}`);
  const { worktrees } = await inspectWorktrees({ root, cfg });
  for (const w of worktrees) out([w.path, w.branch ?? '(detached)', w.state, ...(w.outside ? ['outside'] : [])].join('  '));
  return 0;
}

export default async function worktree({ root, args, out, err }) {
  const [sub, ...rest] = args;
  const cfg = loadConfig(root);
  if (sub === 'add') return add({ root, cfg, args: rest, out });
  if (sub === 'list') return list({ root, cfg, args: rest, out });
  if (sub === 'prune') {
    const bad = rest.find((a) => a !== '--dry-run');
    if (bad !== undefined) throw usage(`unexpected argument ${JSON.stringify(bad)}`);
    return pruneWorktrees({ root, cfg, out, err, dryRun: rest.includes('--dry-run') });
  }
  throw usage(sub === undefined ? 'worktree needs a subcommand: add, list or prune' : `unknown subcommand ${JSON.stringify(sub)}`);
}
