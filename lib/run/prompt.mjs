// The builder's prompt and the default build and evaluate calls of a run (SPEC §8, §10).
import fs from 'node:fs';
import path from 'node:path';

export async function defaultEvaluate(args) {
  const { evaluate } = await import('../eval.mjs');
  return evaluate(args);
}

// The changed-file list of a continued or carried-over build (SPEC §8): at most
// MAX_PROMPT_FILES paths, then '… N more'. A path with a control character (a newline could
// change the prompt's layout) is written as a JSON string with those characters escaped.
export const MAX_PROMPT_FILES = 100;
// eslint-disable-next-line no-control-regex
export const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
export const UNESCAPED = /[\u007f-\u009f\u2028\u2029]/g; // left as is by JSON.stringify
export const promptPath = (f) => (CONTROL.test(f)
  ? JSON.stringify(f).replace(UNESCAPED, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  : f);
export function fileList(files) {
  const lines = files.slice(0, MAX_PROMPT_FILES).map((f) => `- ${promptPath(String(f))}`);
  if (files.length > MAX_PROMPT_FILES) lines.push(`… ${files.length - MAX_PROMPT_FILES} more`);
  return lines;
}

// What the core runs once the builder returns (SPEC §8 verification section): the resolved
// verify.commands, each line redacted with the run's redactor, so the builder leaves them alone.
export function verificationSection(config, redact = (s) => s) {
  const commands = Array.isArray(config?.verify?.commands) ? config.verify.commands : [];
  if (!commands.length) {
    return ['', '## Verification',
      "When you finish, the harness core runs every criterion's `check` in the contract above in this working tree."];
  }
  return ['', '## Verification',
    "When you finish, the harness core runs these verify commands and every criterion's `check` in the contract",
    'above in this working tree:',
    ...commands.map((c) => `- ${promptPath(redact(String(c)))}`),
    "Do not run these commands yourself: run only the criteria's `check` commands and the test files of the modules you changed."];
}

// Tells a headless builder that the interactive workflow in the project's CLAUDE.md/AGENTS.md
// is not its job: the core drives verify and evaluation (SPEC §8, §10).
export function headlessSection() {
  return ['', '## Headless session',
    "This is a headless `harness run` session. The interactive workflow in CLAUDE.md and AGENTS.md (skills,",
    '`harness verify`, `harness eval`) does not apply to this session: the harness core verifies and evaluates',
    'after you return. Do not run harness commands; implement the contract above and report.'];
}

// run.context_files (SPEC §8): the project files every builder prompt carries, after the
// verification section. A body is redacted, then cut at MAX_CONTEXT_CHARS code points.
export const MAX_CONTEXT_CHARS = 16384;
export function contextSection(files, redact = (s) => s) {
  if (!Array.isArray(files) || !files.length) return [];
  const out = ['', '## Project context', ''];
  for (const f of files) {
    const name = promptPath(String(f.path));
    if (f.missing) { out.push(`- ${name}: ${f.outside ? 'outside the worktree' : 'not found'}`); continue; }
    let chars = Array.from(redact(String(f.text ?? '')));
    let note = '';
    if (chars.length > MAX_CONTEXT_CHARS) {
      note = `… truncated (${chars.length - MAX_CONTEXT_CHARS} more characters)`;
      chars = chars.slice(0, MAX_CONTEXT_CHARS);
    }
    let body = chars.join('');
    if (note) body += `${body.endsWith('\n') ? '' : '\n'}${note}`;
    const longest = Math.max(0, ...(body.match(/`+/g) || []).map((r) => r.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    if (out[out.length - 1] !== '') out.push('');
    out.push(`### ${name}`, fence, body.replace(/\n$/, ''), fence);
  }
  return out;
}

// Reads the run.context_files that exist in the worktree; a regular file only (a symbolic
// link as the last element is not followed), anything else is reported as missing. A file whose
// real path (fs.realpathSync.native) is outside the worktree's real path is `outside`, unread.
export function readContextFiles(cwd, list) {
  if (!Array.isArray(list)) return [];
  return list.map((rel) => {
    try {
      const file = path.join(cwd, rel);
      if (!fs.lstatSync(file).isFile()) return { path: rel, missing: true };
      const rel2 = path.relative(fs.realpathSync.native(cwd), fs.realpathSync.native(file));
      if (rel2 === '..' || rel2.startsWith(`..${path.sep}`) || path.isAbsolute(rel2)) return { path: rel, missing: true, outside: true };
      return { path: rel, text: fs.readFileSync(file, 'utf8') };
    } catch { return { path: rel, missing: true }; }
  });
}

// The builder role gets the frozen contract plus what failed last (SPEC §8.2).
// `config` (the run's) is required: it supplies the verification section; `redact` masks its commands.
export function builderPrompt({ rolePrompt, featureId, round, attempt, contract, findings, verifyFailure, conflicts, postMergeFailures, continuation, carriedWork, criteriaStatus, contextFiles, config, redact }) {
  if (!config || typeof config !== 'object') throw new TypeError('builderPrompt needs the run config (the verification section comes from it)');
  const parts = [rolePrompt.trim(), '', `# Task: feature ${featureId}, round ${round}, attempt ${attempt}`, '',
    'Frozen contract:', '```json', JSON.stringify(contract, null, 2), '```'];
  parts.push(...headlessSection());
  parts.push(...verificationSection(config, redact));
  parts.push(...contextSection(contextFiles, redact));
  if (findings?.length) {
    parts.push('', 'Blocking findings from the previous round (fix these first):', '```json', JSON.stringify(findings, null, 2), '```');
  }
  if (verifyFailure) {
    parts.push('', 'Deterministic verification failed on the previous attempt:', '```json', JSON.stringify(verifyFailure, null, 2), '```');
  }
  if (carriedWork?.files?.length) {
    parts.push('', '# Work carried from a previous attempt',
      `The work of a previous attempt at this feature (an earlier run that was blocked) is in this working tree,`,
      `on branch harness/${featureId}. Continue from it and finish the feature against the contract above instead`,
      'of starting over; change or drop whatever the contract no longer asks for. Files changed against the base:',
      ...fileList(carriedWork.files));
  }
  if (continuation?.files?.length) {
    parts.push('', '# Continuation of a timed-out build',
      'The previous attempt timed out before it finished. Its work is still in this working tree; continue',
      'from it and finish the feature instead of starting over. Files changed against the base:',
      ...fileList(continuation.files));
  }
  if (criteriaStatus?.length) {
    parts.push('', '# Criterion status in this working tree',
      "The harness ran each criterion's check in this working tree just before this attempt:",
      ...criteriaStatus.map((c) => `- ${c.id}: ${c.status}`));
  }
  if (conflicts?.length) {
    parts.push('', '# Merge conflict resolution',
      'The feature passed evaluation, but merging it into the integration branch conflicted. The integration',
      'branch is now being merged into this worktree and the merge stopped with conflicts in these files:',
      ...conflicts.map((f) => `- ${f}`),
      'Resolve every conflict so that both this feature and the changes already on the integration branch keep',
      'working, and remove all conflict markers. Do not commit, abort or restart the merge; the harness',
      'completes it and verifies and evaluates the result again.');
  }
  if (postMergeFailures?.length) {
    parts.push('', '# Post-merge verification failure',
      'The feature passed evaluation, but verify failed on the integration branch after the merge, so the',
      'merge was rolled back. The integration branch has been merged into this worktree; these items failed:',
      '```json', JSON.stringify(postMergeFailures, null, 2), '```',
      'Fix the cause so that both this feature and the changes already on the integration branch pass verify.',
      'Do not commit; the harness verifies and evaluates the result again before merging.');
  }
  return parts.join('\n') + '\n';
}

// `adapter`/`model`/`effort` are what the run chose for this call (SPEC §10 role model policy).
// `redact` is the run's redaction (SR-8), applied to an adapter error before it is cut (SR-9).
export async function defaultBuild({ cwd, featureId, round, attempt, contract, findings, verifyFailure, conflicts, postMergeFailures, continuation, carriedWork, criteriaStatus, config, timeoutSec, budgetUsd, signal, redact, adapter: chosen, model: chosenModel, effort: chosenEffort }) {
  const { getAdapter, roleCall: policy } = await import('../adapters/index.mjs');
  const { loadRolePrompt } = await import('../roles.mjs');
  const { adapter: name, model, effort } = chosen !== undefined
    ? { adapter: chosen, model: chosenModel ?? null, effort: chosenEffort ?? null }
    : policy(config, 'builder', { tier: contract?.security_tier, round, conflict: Boolean(conflicts?.length) });
  const adapter = name ? getAdapter(name, config) : null;
  if (!adapter) return { ok: false, error: 'adapter_unavailable', detail: `builder adapter '${name}' is unknown`, costUsd: null };
  const prompt = builderPrompt({ rolePrompt: loadRolePrompt('builder'), featureId, round, attempt, contract, findings, verifyFailure, conflicts, postMergeFailures, continuation, carriedWork, criteriaStatus, contextFiles: readContextFiles(cwd, config?.run?.context_files), config, redact });
  return adapter.run({ role: 'builder', prompt, cwd, readOnly: false, timeoutSec, budgetUsd, model, effort, signal, redact });
}

// ------------------------------------------------------------------ helpers

/**
 * Whether `text` still has a git conflict marker (SPEC §8.10): a line that starts with
 * '<<<<<<< ' or '>>>>>>> ', or is '=======' alone. A marker quoted mid-line is not one.
 */
export function hasConflictMarkers(text) {
  return String(text ?? '').split(/\r?\n/).some((l) => l.startsWith('<<<<<<< ') || l.startsWith('>>>>>>> ') || l === '=======');
}

/**
 * The paths (relative to `wt`) among `files` that still hold a conflict marker. Only regular
 * files are read: a symbolic link is not followed (lstat), so a link to a file outside the
 * repository is never opened (SPEC §8.10).
 */
export function conflictMarkedFiles(wt, files) {
  return [...files].filter((f) => {
    const file = path.join(wt, f);
    let st;
    try { st = fs.lstatSync(file); } catch { return false; }
    return st.isFile() && hasConflictMarkers(fs.readFileSync(file, 'utf8'));
  });
}

