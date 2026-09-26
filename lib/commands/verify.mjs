import path from 'node:path';
import { HarnessError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { verify } from '../verify.mjs';

const USAGE = 'usage: harness verify F<n> [--base <ref>] [--cwd <dir>] [--json]';

function parseArgs(args) {
  const opts = { json: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--base' || a === '--cwd') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) throw new HarnessError(`${a} needs a value\n${USAGE}`, { code: 'usage' });
      opts[a.slice(2)] = v;
      i += 1;
    } else if (a.startsWith('-')) throw new HarnessError(`unknown option '${a}'\n${USAGE}`, { code: 'usage' });
    else if (opts.feature) throw new HarnessError(`unexpected argument '${a}'\n${USAGE}`, { code: 'usage' });
    else opts.feature = a;
  }
  if (!opts.feature) throw new HarnessError(USAGE, { code: 'usage' });
  return opts;
}

const mark = (ok) => (ok ? 'ok  ' : 'FAIL');
// Where a test count came from: parsed (verify command output), ran, or cache.
const src = (s) => (s ? ` [${s}]` : '');

function summary(r) {
  const lines = [`verify ${r.feature} against ${r.base} (merge-base ${r.mergeBase.slice(0, 12)}): ${r.pass ? 'PASS' : 'FAIL'}`];
  lines.push('commands:');
  if (r.commands.length === 0) lines.push('  (none)');
  for (const c of r.commands) {
    lines.push(`  ${mark(c.pass)} ${c.cmd}${c.pass ? '' : ` — ${c.message}${c.flaky ? ' (flaky)' : ''}`}`);
    if (c.flaky_tests?.length) lines.push(`       flaky tests: ${c.flaky_tests.join(', ')}`);
  }
  const { markers, harnessPaths, testCount } = r.integrity;
  lines.push('integrity:');
  lines.push(`  ${mark(markers.length === 0)} skip/focus markers on added lines: ${markers.length}`);
  for (const m of markers) lines.push(`       ${m.file}: ${m.marker}  ${m.line}`);
  lines.push(`  ${mark(harnessPaths.length === 0)} changes under .harness/: ${harnessPaths.length}`);
  for (const p of harnessPaths) lines.push(`       ${p}`);
  const tcOk = testCount.status === 'ok' || testCount.status === 'unset';
  const tcText = testCount.status === 'unset' ? 'not configured'
    : `${testCount.status} (base ${testCount.base ?? '?'}${src(testCount.source?.base)}, head ${testCount.head ?? '?'}${src(testCount.source?.head)})${testCount.message ? ` — ${testCount.message}` : ''}`;
  lines.push(`  ${mark(tcOk)} test count: ${tcText}`);
  lines.push('criteria:');
  for (const c of r.criteria) lines.push(`  ${mark(c.pass)} ${c.id}${c.pass ? '' : ` — ${c.message}`}`);
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  return lines.join('\n');
}

export default async function verifyCommand({ root, args, out }) {
  const opts = parseArgs(args);
  const config = loadConfig(root);
  const base = opts.base ?? config.base_branch;
  const cwd = opts.cwd ? path.resolve(root, opts.cwd) : root;
  const result = await verify({ root, cwd, featureId: opts.feature, base, config });
  out(opts.json ? JSON.stringify(result, null, 2) : summary(result));
  return result.pass ? 0 : 1;
}
