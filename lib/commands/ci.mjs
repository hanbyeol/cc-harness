// `harness ci [<rev>] [--wait]`: the GitHub Actions result of one commit, read with the GitHub
// CLI (SPEC §8.14). Exit 0 success, 1 failure, 3 pending, 2 anything that kept it from an answer.
// Also the ci line of `harness status --brief` (briefCiLine). Reads state, writes nothing.
import { setTimeout as sleep } from 'node:timers/promises';
import { HarnessError } from '../errors.mjs';
import { loadConfig, gitTimeoutOf, DEFAULTS } from '../config.mjs';
import { runCommand, filteredEnv, isNotFound } from '../exec.mjs';
import { resolveInvocation } from '../adapters/common.mjs';
import { usageLine } from '../help.mjs';

const USAGE = usageLine('ci');

// Conclusions that make a commit's CI a failure; success, skipped and neutral do not.
export const FAILED_CONCLUSIONS = Object.freeze(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);
const RUN_FIELDS = 'databaseId,name,workflowName,status,conclusion,url';
const GH_TIMEOUT_SEC = 60;
// status --brief runs in the SessionStart hook (15 s): its gh call gets at most this long.
const BRIEF_TIMEOUT_SEC = 5;
const MAX_SLEEP_MS = 2 ** 31 - 1;

// What gh needs besides the base allowlist: its auth tokens, host and config locations, proxies
// and certificates (SPEC §8.14). Nothing else from the caller's environment reaches gh.
export const GH_ENV = Object.freeze([
  'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);
const ghEnv = () => ({ ...filteredEnv(GH_ENV), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' });

function parseArgs(args) {
  let rev;
  let wait = false;
  for (const a of args) {
    if (a === '--wait') wait = true;
    else if (a.startsWith('-')) throw new HarnessError(`unknown option '${a}'\n${USAGE}`, { code: 'usage' });
    else if (rev !== undefined) throw new HarnessError(`unexpected argument '${a}'\n${USAGE}`, { code: 'usage' });
    else rev = a;
  }
  return { rev: rev ?? 'HEAD', wait };
}

/**
 * The GitHub repository of an origin URL as 'owner/repo' when its host is github.com
 * (https://, ssh://, git:// or scp-like git@github.com:owner/repo), otherwise null.
 */
export function githubRepoOf(url) {
  const s = String(url ?? '').trim();
  let host;
  let pathPart;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      host = u.hostname;
      pathPart = u.pathname;
    } catch { return null; }
  } else {
    const m = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(s);
    if (!m) return null;
    [, host, pathPart] = m;
  }
  if (host.toLowerCase() !== 'github.com') return null;
  const parts = pathPart.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '').split('/');
  if (parts.length !== 2 || parts.some((p) => !/^[A-Za-z0-9._-]+$/.test(p))) return null;
  return parts.join('/');
}

// The github.com repository CI is read from, or null when CI is not enabled for this project:
// config.ci.enabled is false, or origin is missing or not on github.com.
async function ciRepo(root, config, timeoutSec) {
  if (config?.ci?.enabled === false) return null;
  const r = await runCommand({ file: 'git', args: ['remote', 'get-url', 'origin'] }, { cwd: root, timeoutSec });
  if (r.code !== 0 || r.timedOut) return null;
  return githubRepoOf(r.stdout);
}

const lastLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? '';

// Runs `gh <args>` and parses its JSON output. Throws a HarnessError (exit 2) for a missing gh,
// a timeout, a non-zero exit (with gh's last stderr line) or output that is not JSON.
async function ghJson(root, args, timeoutSec) {
  const env = ghEnv();
  const inv = resolveInvocation('gh', args, { env });
  if (!inv) throw new HarnessError('gh not found (install the GitHub CLI)', { code: 'gh_missing' });
  const r = await runCommand(inv, { cwd: root, timeoutSec, env });
  const what = `gh ${args.slice(0, 2).join(' ')}`;
  if (r.timedOut) throw new HarnessError(`${what} timed out after ${timeoutSec}s`, { code: 'gh' });
  if (isNotFound(r)) throw new HarnessError('gh not found (install the GitHub CLI)', { code: 'gh_missing' });
  if (r.code !== 0) throw new HarnessError(`${what} failed (exit ${r.code ?? r.signal ?? r.error}): ${lastLine(r.stderr) || lastLine(r.stdout) || 'no output'}`, { code: 'gh' });
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new HarnessError(`${what}: output is not JSON: ${lastLine(r.stdout).slice(0, 200)}`, { code: 'gh' });
  }
}

const isFailed = (run) => run.status === 'completed' && FAILED_CONCLUSIONS.includes(run.conclusion);
const workflowOf = (run) => String(run.workflowName || run.name || 'workflow');

async function listRuns(root, repo, sha) {
  const runs = await ghJson(root, ['run', 'list', '-R', `github.com/${repo}`, '--commit', sha, '--limit', '100', '--json', RUN_FIELDS], GH_TIMEOUT_SEC);
  if (!Array.isArray(runs)) throw new HarnessError('gh run list: expected a JSON array', { code: 'gh' });
  return runs.filter((x) => x && typeof x === 'object');
}

async function failedJobs(root, repo, id) {
  const view = await ghJson(root, ['run', 'view', String(id), '-R', `github.com/${repo}`, '--json', 'jobs'], GH_TIMEOUT_SEC);
  const jobs = Array.isArray(view?.jobs) ? view.jobs : [];
  return jobs.filter((j) => FAILED_CONCLUSIONS.includes(j?.conclusion)).map((j) => String(j.name));
}

async function resolveCommit(root, rev, timeoutSec) {
  const r = await runCommand({ file: 'git', args: ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`] }, { cwd: root, timeoutSec });
  const sha = r.stdout.trim();
  if (r.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) throw new HarnessError(`unknown revision ${rev}`, { code: 'unknown_revision' });
  return sha;
}

export default async function ci({ root, args, out }) {
  const { rev, wait } = parseArgs(args);
  const config = loadConfig(root);
  const timeoutSec = gitTimeoutOf(config);
  const repo = await ciRepo(root, config, timeoutSec);
  if (!repo) throw new HarnessError('ci: not enabled for this project', { code: 'ci_disabled' });
  const sha = await resolveCommit(root, rev, timeoutSec);
  const sha7 = sha.slice(0, 7);
  const opt = { ...DEFAULTS.ci, ...config.ci };
  const start = Date.now();
  const elapsed = () => (Date.now() - start) / 1000;

  for (;;) {
    const runs = await listRuns(root, repo, sha);
    const failed = runs.filter(isFailed);
    const pending = runs.filter((x) => x.status !== 'completed');
    // A failure is reported as soon as one run has failed, even while others still run.
    const done = runs.length > 0 && (failed.length > 0 || pending.length === 0 || !wait);
    if (done || !wait) {
      if (runs.length === 0) throw new HarnessError(`no CI run for ${sha7}`, { code: 'ci_no_run' });
      for (const run of runs) {
        out(`${workflowOf(run)}  ${run.status === 'completed' ? run.conclusion || 'completed' : run.status || 'unknown'}  ${run.url ?? ''}`.trimEnd());
        if (isFailed(run)) for (const job of await failedJobs(root, repo, run.databaseId)) out(`  failed job: ${job}`);
      }
      const result = failed.length ? 'failure' : pending.length ? 'pending' : 'success';
      out(`ci ${sha7}: ${result}`);
      return result === 'failure' ? 1 : result === 'pending' ? 3 : 0;
    }
    const limit = runs.length === 0 ? opt.find_timeout_sec : opt.timeout_sec;
    if (elapsed() >= limit) {
      if (runs.length === 0) throw new HarnessError(`no CI run for ${sha7}`, { code: 'ci_no_run' });
      for (const run of runs) out(`${workflowOf(run)}  ${run.status === 'completed' ? run.conclusion : run.status}  ${run.url ?? ''}`.trimEnd());
      throw new HarnessError(`ci ${sha7}: timed out waiting`, { code: 'ci_timeout' });
    }
    const remainingMs = (limit - elapsed()) * 1000;
    await sleep(Math.max(0, Math.min(opt.poll_sec * 1000, remainingMs, MAX_SLEEP_MS)));
  }
}

/**
 * The ci line of `status --brief`: `ci: <base> <sha7> failing — <workflow> (harness ci <sha7>)`
 * when the latest completed run on the base branch failed, otherwise null. Any problem (CI not
 * enabled, no git, no gh, a gh error, output that is not JSON, more than 5 s) is null.
 */
export async function briefCiLine(root, config) {
  try {
    const repo = await ciRepo(root, config, BRIEF_TIMEOUT_SEC);
    if (!repo) return null;
    const base = config.base_branch;
    const runs = await ghJson(root, ['run', 'list', '-R', `github.com/${repo}`, '--branch', base, '--status', 'completed', '--limit', '1',
      '--json', 'databaseId,headSha,name,workflowName,status,conclusion,url'], BRIEF_TIMEOUT_SEC);
    const run = Array.isArray(runs) ? runs[0] : null;
    if (!run || !FAILED_CONCLUSIONS.includes(run.conclusion) || typeof run.headSha !== 'string' || !/^[0-9a-f]{7,}$/.test(run.headSha)) return null;
    const sha7 = run.headSha.slice(0, 7);
    return `ci: ${base} ${sha7} failing — ${workflowOf(run)} (harness ci ${sha7})`;
  } catch {
    return null;
  }
}
