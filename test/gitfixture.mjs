// Throwaway git repositories for tests. Everything is local to a temp dir:
// identity, signing and hooks are pinned in the repo config so the user's
// global git config cannot change the outcome.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from './helpers.mjs';

export function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr || r.error}`);
  return r.stdout.trim();
}

// Writes { 'rel/path': content } under dir (content: string, or object → JSON).
export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
}

export function commitAll(dir, message = 'commit') {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * A repo with `files` committed on branch `base` (default main), then checked
 * out on a new `branch` (default feature). Returns the repo directory.
 */
export function gitRepo(files = {}, { base = 'main', branch = 'feature' } = {}) {
  const dir = fs.realpathSync(tmpdir('harness-git-'));
  git(dir, 'init', '-q');
  git(dir, 'symbolic-ref', 'HEAD', `refs/heads/${base}`);
  git(dir, 'config', 'user.name', 'Harness Test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'no-hooks'));
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFiles(dir, files);
  commitAll(dir, 'base');
  if (branch) git(dir, 'checkout', '-q', '-b', branch);
  return dir;
}
