// Core git calls, the integration and feature worktrees, branches and taking over a
// blocked run's work (SPEC §8, §8.10).
// ------------------------------------------------------------------ git
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HarnessError } from '../errors.mjs';
import { HARNESS_DIR } from '../state.mjs';
import { TEST_COUNT_CACHE } from '../testcount.mjs';
import { VERIFY_CACHE } from '../verify-cache.mjs';
import { gitTimeoutOf } from '../config.mjs';
import { runCommand, gitTimeoutError } from '../exec.mjs';
import { makeTempDir } from '../tmp.mjs';
import { INTEGRATION_WT } from './common.mjs';
import { resolveWorktreeDir, prepareWorktreeDir } from './wtdir.mjs';

let noHooksDir = null;
// An empty directory as core.hooksPath: no repository hook runs during core git calls.
// One per process, removed when the process exits (tmp.mjs).
export function hooksOff() {
  if (!noHooksDir || !fs.existsSync(noHooksDir)) noHooksDir = makeTempDir('harness-no-hooks-');
  return noHooksDir;
}

// Commits and merges the core makes are authored by the core, unsigned, hook-free.
export const coreGitArgs = () => ['-c', `core.hooksPath=${hooksOff()}`, '-c', 'core.quotePath=false',
  '-c', 'commit.gpgsign=false', '-c', 'user.name=cc-harness', '-c', 'user.email=cc-harness@localhost'];

/**
 * The core git runner: `git(args, cwd, {timeoutSec})` → {code, stdout, stderr}.
 * timeoutSec is budget.git_timeout_sec; past it the command's tree is killed and this throws.
 */
export async function git(args, cwd, { timeoutSec = gitTimeoutOf(null) } = {}) {
  const r = await runCommand({ file: 'git', args: [...coreGitArgs(), ...args] }, { cwd, timeoutSec });
  if (r.error === 'ENOENT') throw new HarnessError('git is not installed or not on PATH', { code: 'git_missing' });
  if (r.timedOut) throw gitTimeoutError(args, timeoutSec);
  return r;
}

/**
 * Git calls that change worktrees, branches, merge state, the index or commits. A run makes them
 * one at a time (SPEC §8.10): concurrent `worktree add`/`branch`/`merge`/`add`/`commit`/`reset --hard`
 * calls race on shared repository files (refs, objects, worktree metadata).
 */
export function isSerializedGit(args) {
  const [cmd, sub] = args;
  if (cmd === 'worktree') return sub === 'add' || sub === 'remove' || sub === 'prune';
  if (cmd === 'reset') return args.includes('--hard');
  if (cmd === 'update-ref') return args.includes('-d');
  if (cmd === 'config') return args.includes('--remove-section');
  return cmd === 'branch' || cmd === 'merge' || cmd === 'checkout' || cmd === 'switch' || cmd === 'add' || cmd === 'commit';
}

export const gitCause = (r) => (r.stderr || r.stdout || r.error || (r.timedOut ? 'timed out' : `exit ${r.code}`)).trim();

export async function gitOk(run, args, cwd, what) {
  const r = await run(args, cwd);
  if (r.code !== 0) throw new HarnessError(`${what}: ${gitCause(r)}`, { code: 'git' });
  return r.stdout.trim();
}

export async function revParse(run, ref, cwd) {
  const r = await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
  return r.code === 0 ? r.stdout.trim() : null;
}

// Paths that differ from HEAD in a worktree — staged, unstaged, unmerged or untracked — from
// the top of the worktree. -z: no quoting; a rename or copy entry is followed by its source path.
export async function dirtyPaths(run, cwd) {
  const r = await run(['status', '--porcelain', '-z', '--untracked-files=all'], cwd);
  if (r.code !== 0) throw new HarnessError(`git status failed: ${gitCause(r)}`, { code: 'git' });
  const tokens = r.stdout.split('\0');
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].length < 4) continue;
    out.push(tokens[i].slice(3));
    if (tokens[i][0] === 'R' || tokens[i][0] === 'C') i += 1;
  }
  return out;
}

// Paths a feature worktree changed against `base` — committed since, staged, unstaged or
// untracked — for the continuation of a timed-out build (SPEC §8). Names only, sorted.
export async function changedFromBase(run, cwd, base) {
  const r = await run(['diff', '--name-only', '-z', base, 'HEAD'], cwd);
  if (r.code !== 0) throw new HarnessError(`git diff failed: ${gitCause(r)}`, { code: 'git' });
  return [...new Set([...r.stdout.split('\0').filter(Boolean), ...(await dirtyPaths(run, cwd))])].sort();
}

// Content hash of a regular file; null when it is missing or not a file.
export function contentHash(file) {
  try {
    return fs.statSync(file).isFile() ? crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex') : null;
  } catch {
    return null;
  }
}

// {path: content hash} of every path that differs from HEAD: where a conflict resolution starts.
export async function worktreeSnapshot(run, cwd) {
  return Object.fromEntries((await dirtyPaths(run, cwd)).map((f) => [f, contentHash(path.join(cwd, f))]));
}

// Paths the conflict resolution changed (SPEC §8.10): paths that differ from the pre-merge HEAD
// now (in the worktree, or in commits made since) and whose content is not what `snapshot`
// recorded. Without a snapshot (a state file written before F38) every such path counts.
export async function changedSince(run, cwd, { preMergeHead, snapshot }) {
  const paths = new Set(await dirtyPaths(run, cwd));
  const head = await revParse(run, 'HEAD', cwd);
  if (preMergeHead && head && head !== preMergeHead) {
    const d = await run(['diff', '--name-only', '-z', preMergeHead, head], cwd);
    if (d.code !== 0) throw new HarnessError(`git diff failed: ${gitCause(d)}`, { code: 'git' });
    for (const f of d.stdout.split('\0')) if (f) paths.add(f);
  }
  if (!snapshot) return [...paths];
  return [...paths].filter((f) => !Object.hasOwn(snapshot, f) || snapshot[f] !== contentHash(path.join(cwd, f)));
}

export function canonical(p) {
  let out = path.resolve(p);
  try { out = fs.realpathSync.native(out); } catch { /* not created yet */ }
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

// [{path, branch}] from `git worktree list --porcelain`.
export async function listWorktrees(run, cwd) {
  const text = await gitOk(run, ['worktree', 'list', '--porcelain'], cwd, 'git worktree list failed');
  const list = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) list.push({ path: line.slice('worktree '.length), branch: null });
    else if (line.startsWith('branch ') && list.length) list[list.length - 1].branch = line.slice('branch '.length);
  }
  return list;
}

export async function registeredWorktree(run, cwd, dir, branch) {
  const want = canonical(dir);
  return (await listWorktrees(run, cwd)).some((w) => canonical(w.path) === want && w.branch === `refs/heads/${branch}`);
}

// ------------------------------------------------------------------ protected branches (SR-5)

// Branch names are compared case-insensitively: on case-insensitive filesystems (macOS,
// Windows defaults) refs/heads/Main is the same loose ref as refs/heads/main, so a
// case variant of a protected name would merge straight into it.
export const foldBranch = (b) => String(b).toLowerCase();

export function protectedSet(config) {
  const list = Array.isArray(config.protected_branches) ? config.protected_branches : [];
  const names = new Set(['main', ...list.filter((b) => typeof b === 'string' && b)].map(foldBranch));
  return { has: (b) => typeof b === 'string' && names.has(foldBranch(b)), names };
}

/**
 * Throws (exit 2) unless integration_branch is spelled as a short branch name. 'refs/…' and
 * 'heads/…' pass `git check-ref-format --branch` but name refs/heads/refs/… and a branch the
 * merge-time HEAD check cannot match, so the run would stop only after building (SPEC §8).
 */
export function assertIntegrationName(config) {
  const integ = config.integration_branch;
  if (typeof integ !== 'string' || !integ || integ.startsWith('-')) {
    throw new HarnessError(`integration_branch must be a branch name (got ${JSON.stringify(integ)})`, { code: 'config' });
  }
  if (integ.startsWith('refs/') || integ.startsWith('heads/')) {
    throw new HarnessError(`integration_branch '${integ}' must be a short branch name, not a ref path starting with 'refs/' or 'heads/' (for example 'harness/integration')`, { code: 'config_invalid' });
  }
}

/**
 * Throws unless the integration branch is a legal, unprotected merge target.
 * `runGit(args, cwd)` → {code, stdout, stderr} is the git runner (injectable for tests).
 */
export async function assertIntegrationAllowed(config, cwd, { runGit = git } = {}) {
  const integ = config.integration_branch;
  const prot = protectedSet(config);
  assertIntegrationName(config);
  if (prot.has(integ)) {
    throw new HarnessError(`integration_branch '${integ}' is protected — harness never merges into protected branches (SR-5). Set integration_branch to a dedicated branch.`, { code: 'protected_branch' });
  }
  if (typeof config.base_branch === 'string' && foldBranch(integ) === foldBranch(config.base_branch) && prot.has(config.base_branch)) {
    throw new HarnessError(`integration_branch equals the protected base '${integ}' (SR-5)`, { code: 'protected_branch' });
  }
  const r = await runGit(['check-ref-format', '--branch', integ], cwd);
  if (r.code !== 0) throw new HarnessError(`integration_branch '${integ}' is not a valid branch name`, { code: 'config' });
  // A local branch spelled differently but equal after case folding is the same loose ref
  // on a case-insensitive filesystem: the run would advance the user's branch (F10).
  const refs = await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads/'], cwd);
  if (refs.code !== 0) throw new HarnessError(`cannot list local branches (git for-each-ref): ${gitCause(refs)}`, { code: 'git' });
  const clash = refs.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('refs/heads/'))
    .map((l) => l.slice('refs/heads/'.length))
    .find((b) => b !== integ && foldBranch(b) === foldBranch(integ));
  if (clash !== undefined) {
    throw new HarnessError(`integration_branch '${integ}' differs only by case from the existing local branch '${clash}' — on a case-insensitive filesystem they are the same branch, so the run would move '${clash}'. Rename one of them or choose another integration_branch.`, { code: 'branch_case' });
  }
}

// Sets up what a run needs from git: refuses unsafe branches (SR-5), creates the integration
// branch and its worktree if missing, and puts the worktree helpers on the run context.
export async function attachGit(ctx) {
  const { root, cfg, d, p, g, runGit } = ctx;
  // Refuse before touching anything (SR-5).
  const top = await gitOk(g, ['rev-parse', '--show-toplevel'], root, `${root} is not inside a git repository`);
  const projectRel = path.relative(canonical(top), canonical(root));
  // Where the worktrees go: the directory a resumed run recorded, else run.worktree_dir (SPEC §8).
  const wt = ctx.resume
    ? { dir: path.isAbsolute(ctx.state.worktreeDir ?? '') ? ctx.state.worktreeDir : p.worktrees, external: false }
    : resolveWorktreeDir({ root, top, value: cfg.run?.worktree_dir, defaultDir: p.worktrees });
  if (!ctx.resume) ctx.state.worktreeDir = wt.dir;
  const wtDir = wt.dir;
  await assertIntegrationAllowed(cfg, root, { runGit });
  const integ = cfg.integration_branch;
  const prot = protectedSet(cfg);
  ctx.createdIntegration = false;
  ctx.createdIntegrationWt = false;
  if (!(await revParse(g, `refs/heads/${integ}`, root))) {
    const baseSha = await revParse(g, cfg.base_branch, root);
    if (!baseSha) throw new HarnessError(`base branch '${cfg.base_branch}' not found — cannot create '${integ}'`, { code: 'base_missing' });
    await gitOk(g, ['branch', integ, baseSha], root, `cannot create integration branch '${integ}'`);
    d.log(`created integration branch ${integ} from ${cfg.base_branch}`);
    ctx.createdIntegration = true;
  }
  // A dedicated worktree for merges: the user's own worktree never changes branch.
  const intWt = path.join(wtDir, INTEGRATION_WT);
  if (!(await registeredWorktree(g, root, intWt, integ))) {
    if (fs.existsSync(intWt)) throw new HarnessError(`${intWt} exists but is not a worktree of '${integ}' — remove it`, { code: 'worktree' });
    prepareWorktreeDir(root, wt);
    await gitOk(g, ['worktree', 'add', intWt, integ], root, `cannot create the integration worktree for '${integ}' (is it checked out elsewhere?)`);
    ctx.createdIntegrationWt = true;
  }
  const intCwd = path.join(intWt, projectRel);
  const wtOf = (id) => path.join(wtDir, id);
  const cwdOf = (id) => path.join(wtOf(id), projectRel);
  // The test-count and verify result caches as paths from a worktree's top level, in git's '/' form.
  const cacheRel = [...(projectRel ? projectRel.split(path.sep) : []), HARNESS_DIR, 'runs', TEST_COUNT_CACHE].join('/');
  const verifyCacheRel = [...(projectRel ? projectRel.split(path.sep) : []), HARNESS_DIR, 'runs', VERIFY_CACHE].join('/');
  // Events a command recorded inside a worktree stay there: every feature branch appending to
  // the same month file would make each merge conflict (SPEC §2 이벤트 기록).
  const eventsRel = [...(projectRel ? projectRel.split(path.sep) : []), HARNESS_DIR, 'events'].join('/');
  const harnessRel = [...(projectRel ? projectRel.split(path.sep) : []), HARNESS_DIR].join('/');
  // Exclude pathspecs for the core's local records. git refuses `add` when a pathspec names an
  // existing path that .gitignore already ignores, even as an exclude, so an ignored record path
  // is left out of the pathspec: `add -A` skips ignored files anyway.
  const localRecordExcludes = async (wt) => {
    const out = [];
    for (const rel of [cacheRel, verifyCacheRel, eventsRel]) {
      if ((await g(['check-ignore', '-q', '--', rel], wt)).code !== 0) out.push(`:(exclude,literal)${rel}`);
    }
    return out;
  };
  // The builder's uncommitted work becomes a core-authored commit on the feature branch (SPEC §8):
  // after each build attempt, so the feature verify sees what the post-merge verify will see, and
  // before the merge for anything left since. No change, no commit.
  const commitBuilderChanges = async (e) => {
    const wt = wtOf(e.feature);
    if (!(await gitOk(g, ['status', '--porcelain'], wt, 'git status failed'))) return;
    // The test-count cache and events are the core's local records, never part of the feature (§6.2-3).
    await gitOk(g, ['add', '-A', '--', '.', ...(await localRecordExcludes(wt))], wt, 'git add failed');
    if ((await g(['diff', '--cached', '--quiet'], wt)).code !== 0) {
      await gitOk(g, ['commit', '-q', '-m', `harness: ${e.feature} round ${e.round} builder changes`], wt, 'commit of builder changes failed');
    }
  };
  Object.assign(ctx, { projectRel, integ, prot, intWt, intCwd, harnessRel, wtOf, cwdOf, localRecordExcludes, commitBuilderChanges });
}

export const pathExists = (p) => {
  try { fs.lstatSync(p); return true; } catch { return false; }
};
export const describeWorktree = (w) => (w.branch ? `branch ${w.branch.replace(/^refs\/heads\//, '')}` : 'a detached HEAD');

export async function worktreeAt(ctx, dir) {
  const want = canonical(dir);
  return (await listWorktrees(ctx.g, ctx.root)).find((w) => canonical(w.path) === want) ?? null;
}

// The worktree a blocked run left for a re-approved feature (SPEC §8): taken over only when
// git lists it as a worktree of this repository on harness/F{n}. Uncommitted work in it is
// committed first. base is the merge-base of harness/F{n} and integration (F145). Returns {base, carried: {files, commit}} or {blocked: detail}.
export async function takeOver(ctx, id, base) {
  const { g, integ, wtOf, localRecordExcludes } = ctx;
  const wt = wtOf(id);
  const branch = `harness/${id}`;
  const w = await worktreeAt(ctx, wt);
  if (!w) return { blocked: `${wt} exists but is not a registered worktree of this repository (expected branch ${branch}) — not taken over; move it away by hand` };
  if (w.branch !== `refs/heads/${branch}`) return { blocked: `${wt} is a worktree on ${describeWorktree(w)}, not ${branch} — not taken over` };
  if (await revParse(g, 'MERGE_HEAD', wt)) return { blocked: `${wt} (branch ${branch}) is in the middle of a merge — finish or abort it by hand, or start over with --fresh` };
  let commit = null;
  if (await gitOk(g, ['status', '--porcelain'], wt, 'git status failed')) {
    // The test-count cache and events are the core's local records, never part of the feature (§6.2-3).
    await gitOk(g, ['add', '-A', '--', '.', ...(await localRecordExcludes(wt))], wt, 'git add failed');
    if ((await g(['diff', '--cached', '--quiet'], wt)).code !== 0) {
      await gitOk(g, ['commit', '-q', '-m', `harness: ${id} carried work`], wt, 'commit of the carried work failed');
      commit = await revParse(g, 'HEAD', wt);
    }
  }
  const from = base ? await gitOk(g, ['merge-base', base, 'HEAD'], wt, `no merge base of ${integ} and ${branch}`) : null;
  const files = from ? await changedFromBase(g, wt, from) : [];
  return { base: from ?? base, carried: { files, commit } };
}

// Deletes refs/heads/<branch> only while it is still at `sha`, with update-ref -d: branch -D always
// rewrites .git/config (lock file + rename), which fails a concurrent unlocked read on Windows.
// The config is rewritten only when the branch has a [branch "<name>"] section, as branch -D does.
export async function deleteBranch(g, root, branch, sha) {
  const r = await g(['update-ref', '-d', `refs/heads/${branch}`, sha], root);
  if (r.code === 0 && (await g(['config', '--get-regexp', `^branch\\.${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`], root)).code === 0) {
    await g(['config', '--remove-section', `branch.${branch}`], root);
  }
  return r;
}

// --fresh (SPEC §8): the feature's leftover worktree and branch are removed before it starts.
// Returns null, or the blocked(worktree) detail when something could not be removed.
export async function removeLeftover(ctx, id) {
  const { root, d, g, wtOf } = ctx;
  const wt = wtOf(id);
  const branch = `harness/${id}`;
  if (pathExists(wt)) {
    const w = await worktreeAt(ctx, wt);
    if (!w) return `--fresh: ${wt} is not a registered worktree of this repository (expected branch ${branch}) — not removed; move it away by hand`;
    if (w.branch !== `refs/heads/${branch}`) return `--fresh: ${wt} is a worktree on ${describeWorktree(w)}, not ${branch} — not removed`;
    const r = await g(['worktree', 'remove', '--force', wt], root);
    if (r.code !== 0) return `--fresh could not remove the worktree ${wt}: ${gitCause(r)}`;
  }
  const sha = await revParse(g, `refs/heads/${branch}`, root);
  if (sha) {
    // update-ref -d does not refuse a branch checked out elsewhere, as branch -D did.
    const other = (await listWorktrees(g, root)).find((w) => w.branch === `refs/heads/${branch}`);
    if (other) return `--fresh could not delete the branch ${branch}: it is checked out at ${other.path}`;
    const r = await deleteBranch(g, root, branch, sha);
    if (r.code !== 0) return `--fresh could not delete the branch ${branch}: ${gitCause(r)}`;
  }
  d.log(`${id}: --fresh removed the leftover worktree and branch`);
  return null;
}
