// Where a run puts its worktrees: config `run.worktree_dir` resolved against the project root,
// checked before anything is created, and marked as owned when it lies outside the repository
// (SPEC §8 worktree 위치).
import fs from 'node:fs';
import path from 'node:path';
import { HarnessError } from '../errors.mjs';

export const OWNER_MARK = '.harness-worktrees.json';

const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// The path with symlinks resolved as far as it exists; the part that does not exist yet is appended.
export function realResolve(abs) {
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

// `inner` is `outer` itself or below it (both resolved, folded for the platform).
const within = (outer, inner) => {
  const rel = path.relative(fold(outer), fold(inner));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

const refuse = (value, real, why) => new HarnessError(
  `run.worktree_dir ${JSON.stringify(value)} resolves to ${real}: ${why} (worktree_dir)`, { code: 'worktree_dir' });

function readMark(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, OWNER_MARK), 'utf8'));
    return typeof m?.project === 'string' ? m.project : null;
  } catch {
    return null;
  }
}

/**
 * Resolves and checks `run.worktree_dir` without creating anything.
 * Returns {dir, external}; `external` is false for the default `<project>/.harness/wt`.
 */
export function resolveWorktreeDir({ root, top, value, defaultDir }) {
  // The default keeps its path as given: resolving it would change it (e.g. a Windows 8.3 short
  // name expands), and the default must stay the path the run used before run.worktree_dir.
  if (value === undefined) return { dir: defaultDir, external: false };
  const legacy = realResolve(defaultDir);
  const real = realResolve(path.resolve(root, value));
  if (fold(real) === fold(legacy)) return { dir: defaultDir, external: false };
  const topReal = realResolve(top);
  if (within(topReal, real)) {
    throw refuse(value, real, `it is inside the repository working tree (only ${legacy} is allowed there)`);
  }
  if (within(real, topReal)) throw refuse(value, real, 'it contains the repository');
  if (!fs.existsSync(path.dirname(real))) throw refuse(value, real, `its parent directory ${path.dirname(real)} does not exist`);
  if (fs.existsSync(real)) {
    if (!fs.statSync(real).isDirectory()) throw refuse(value, real, 'it is not a directory');
    if (fs.readdirSync(real).length > 0) {
      const mark = readMark(real);
      if (mark === null || fold(mark) !== fold(fs.realpathSync.native(root))) {
        throw refuse(value, real, `it is not empty and has no ${OWNER_MARK} naming this project — use an empty or new directory`);
      }
    }
  }
  return { dir: real, external: true };
}

// Creates the directory and, when it is outside the repository, its owner mark.
export function prepareWorktreeDir(root, { dir, external }) {
  fs.mkdirSync(dir, { recursive: true });
  if (external && readMark(dir) === null) {
    fs.writeFileSync(path.join(dir, OWNER_MARK), `${JSON.stringify({ project: fs.realpathSync.native(root) })}\n`);
  }
}
