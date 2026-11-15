// `harness guard-worktree`: the PreToolUse hook for Bash (hooks/hooks.json). Reads the hook's
// JSON from stdin and denies a `git [-C <dir>] worktree add … <path>` whose path is outside the
// repository's working tree (SPEC §8.12). Anything else, including input it cannot read, passes
// silently with exit 0: the hook must never get in the way of other commands.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { realResolve, within } from '../run/wtdir.mjs';

const SEPARATORS = new Set([';', '&', '|', '\n', '(', ')']);

/**
 * Splits a shell command into segments of words at ; & | newline and parentheses. Quotes and
 * backslashes are honoured as a POSIX shell would; expansions are not (threat model D1).
 */
export function segments(command) {
  const out = [[]];
  let word = null;
  const end = () => { if (word !== null) out.at(-1).push(word); word = null; };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (c === "'") {
      const j = command.indexOf("'", i + 1);
      const stop = j === -1 ? command.length : j;
      word = (word ?? '') + command.slice(i + 1, stop);
      i = stop;
    } else if (c === '"') {
      word ??= '';
      for (i += 1; i < command.length && command[i] !== '"'; i += 1) {
        if (command[i] === '\\' && i + 1 < command.length && '"\\$`\n'.includes(command[i + 1])) i += 1;
        word += command[i];
      }
    } else if (c === '\\') {
      if (command[i + 1] === '\n') i += 1;
      else if (i + 1 < command.length) { word = (word ?? '') + command[i + 1]; i += 1; }
    } else if (SEPARATORS.has(c)) {
      end();
      if (out.at(-1).length) out.push([]);
    } else if (c === ' ' || c === '\t' || c === '\r') end();
    else word = (word ?? '') + c;
  }
  end();
  return out.filter((s) => s.length);
}

// Global git options that take the next word as their value.
const GIT_VALUE_OPTS = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path']);
// `git worktree add` options that take the next word as their value.
const ADD_VALUE_OPTS = new Set(['-b', '-B', '--reason']);

const isGit = (w) => w === 'git' || /[\\/]git(\.exe)?$/i.test(w) || w === 'git.exe';

/** [{dirs: [-C values], target}] for every `git … worktree add … <path>` in the command. */
export function worktreeAdds(command) {
  const found = [];
  for (const words of segments(command)) {
    for (let g = 0; g < words.length; g += 1) {
      if (!isGit(words[g])) continue;
      const dirs = [];
      let i = g + 1;
      for (; i < words.length && words[i].startsWith('-'); i += 1) {
        if (words[i] === '-C') { if (i + 1 < words.length) dirs.push(words[i + 1]); i += 1; }
        else if (GIT_VALUE_OPTS.has(words[i])) i += 1;
      }
      if (words[i] !== 'worktree' || words[i + 1] !== 'add') continue;
      let target;
      for (let j = i + 2; j < words.length; j += 1) {
        const w = words[j];
        if (w === '--') { target = words[j + 1]; break; }
        if (ADD_VALUE_OPTS.has(w)) { j += 1; continue; }
        if (w.startsWith('-') && w !== '-') continue;
        target = w;
        break;
      }
      if (target !== undefined) found.push({ dirs, target });
    }
  }
  return found;
}

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

// The repository working-tree top for `dir`, or null when it is not in one.
function repoTop(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', timeout: 5000, windowsHide: true });
  const top = r.status === 0 ? r.stdout.trim() : '';
  return top ? path.resolve(top) : null;
}

/** The deny reason for the hook input, or null to let the command run. */
export function denial(input) {
  const command = input?.tool_input?.command;
  if (typeof command !== 'string') return null;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  for (const { dirs, target } of worktreeAdds(command)) {
    const dir = dirs.reduce((d, c) => path.resolve(d, expandHome(c)), path.resolve(cwd));
    const top = repoTop(dir);
    if (!top) continue;
    const abs = path.resolve(dir, expandHome(target));
    if (within(realResolve(top), realResolve(abs))) continue;
    return `git worktree add ${abs} is outside the repository ${top}. Keep worktrees inside the project: `
      + 'use `harness worktree add <name>` (creates .harness/wt/<name> on a new branch) or `harness run`, '
      + 'and after merge and push run `harness worktree prune`.';
  }
  return null;
}

export default async function guardWorktree({ out }) {
  try {
    if (process.stdin.isTTY) return 0;
    const reason = denial(JSON.parse(fs.readFileSync(0, 'utf8')));
    if (reason) {
      out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    }
  } catch {
    // Unreadable or invalid input: let the command run.
  }
  return 0;
}
