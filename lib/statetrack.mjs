import { git } from './run/worktree.mjs';

// Whether the project's state (.harness/config.json stands for .harness/) is in git (SPEC §4.1, §13).
const CONFIG = '.harness/config.json';
const BRIEF_TIMEOUT_SEC = 10;
const coreRun = (args, cwd, opts) => git(args, cwd, opts);

export const NOT_COMMITTED_LINE = 'state: .harness/ is not committed — commit it (git add .harness)';
export const MIGRATE_NEXT_LINE = 'next: commit .harness/ — the state lives in git (git add .harness && git commit)';

/**
 * { state: 'tracked' } · { state: 'untracked' } · { state: 'ignored', source, line }, or null when
 * git cannot tell (not a repository, git missing, failing or past the timeout). Paths are relative
 * to root, the project root, which may be a subdirectory of the repository.
 */
export async function stateTracking(root, { run = coreRun, timeoutSec = BRIEF_TIMEOUT_SEC } = {}) {
  try {
    const [ls, ign] = await Promise.all([
      run(['ls-files', '--error-unmatch', '--', CONFIG], root, { timeoutSec }),
      run(['check-ignore', '-v', '--no-index', '--', CONFIG], root, { timeoutSec }),
    ]);
    if (ls.code === 0) return { state: 'tracked' };
    if (ls.code !== 1) return null;
    if (ign.code === 1) return { state: 'untracked' };
    if (ign.code !== 0) return null;
    // `<source>:<line>:<pattern>\t<path>` (a Windows source may hold a drive colon, so the line
    // number is the first `:<digits>:`). A negated pattern does not ignore.
    const m = /^(.+?):(\d+):([^\t]*)\t/.exec(String(ign.stdout));
    if (!m) return null;
    if (m[3].startsWith('!')) return { state: 'untracked' };
    return { state: 'ignored', source: m[1], line: m[2] };
  } catch {
    return null;
  }
}

// The `status --brief` state line, or null when there is nothing to say or git cannot tell.
export async function briefStateLine(root, opts) {
  const t = await stateTracking(root, opts);
  if (t?.state === 'untracked') return NOT_COMMITTED_LINE;
  if (t?.state === 'ignored') return `state: .harness/ is ignored by git (${t.source}:${t.line}) — state must be tracked`;
  return null;
}
