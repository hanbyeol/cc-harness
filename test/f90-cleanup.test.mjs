// F90: code cleanup — unused exports and re-exports removed, test-only code under test/,
// the unreferenced rules/ directory removed, verify's fixed git options aligned with eval's.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO, tmpdir, BIN } from './helpers.mjs';
import { gitRepo, writeFiles, commitAll } from './gitfixture.mjs';
import { resolveConfig } from '../lib/config.mjs';
import { verify } from '../lib/verify.mjs';

const POSIX = process.platform !== 'win32'; // the fake git is a shebang script
const mod = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// Names a test file imports from a module (static `import { a, b as c } from '<spec>'`).
function importedNames(src, spec) {
  const names = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (!m[2].endsWith(spec)) continue;
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}
const testFiles = () => fs.readdirSync(path.join(REPO, 'test')).filter((f) => f.endsWith('.test.mjs'));

// ---------- AC-1 ----------
test('F90 AC-1: lib/telemetry.mjs does not export lastExport, isShareOn or isAutoExportOn', async () => {
  const t = await mod('lib/telemetry.mjs');
  for (const name of ['lastExport', 'isShareOn', 'isAutoExportOn']) {
    assert.equal(name in t, false, `telemetry.mjs still exports ${name}`);
  }
  assert.equal(typeof t.readExported, 'function', 'the module itself still loads');
});

// ---------- AC-2 ----------
test('F90 AC-2: run.mjs and adapters/index.mjs do not re-export helpers; tests import them from their own module', async () => {
  const run = await mod('lib/run.mjs');
  for (const name of ['redactor', 'verifyFailures']) assert.equal(name in run, false, `run.mjs re-exports ${name}`);
  const index = await mod('lib/adapters/index.mjs');
  for (const name of ['extractJson', 'parseOutput', 'parseUsage']) {
    assert.equal(name in index, false, `adapters/index.mjs re-exports ${name}`);
  }
  const failures = await mod('lib/failures.mjs');
  const common = await mod('lib/adapters/common.mjs');
  for (const name of ['redactor', 'verifyFailures']) assert.equal(typeof failures[name], 'function', name);
  for (const name of ['extractJson', 'parseOutput', 'parseUsage']) assert.equal(typeof common[name], 'function', name);

  for (const f of testFiles()) {
    const src = read(`test/${f}`);
    for (const name of importedNames(src, '/lib/run.mjs')) {
      assert.ok(!['redactor', 'verifyFailures'].includes(name), `${f} imports ${name} from lib/run.mjs`);
    }
    for (const name of importedNames(src, '/lib/adapters/index.mjs')) {
      assert.ok(!['extractJson', 'parseOutput', 'parseUsage'].includes(name), `${f} imports ${name} from lib/adapters/index.mjs`);
    }
  }
});

// ---------- AC-3 ----------
test('F90 AC-3: the stress tool\'s code lives under test/ and stresses one test file', async () => {
  assert.equal(fs.existsSync(path.join(REPO, 'lib', 'stress.mjs')), false, 'lib/stress.mjs still exists');
  const glob = await mod('lib/glob.mjs');
  assert.equal('expandFileGlob' in glob, false, 'lib/glob.mjs still exports expandFileGlob');
  assert.doesNotMatch(read('test/stress.mjs'), /['"]\.\.\/lib\//, 'test/stress.mjs imports nothing from lib/');

  const env = { ...process.env, NODE_TEST_CONTEXT: undefined };
  const r = spawnSync(process.execPath, [path.join(REPO, 'test', 'stress.mjs'), '1', '--files', 'test/f1-core.test.mjs'],
    { cwd: REPO, env, encoding: 'utf8', timeout: 600_000 });
  assert.equal(r.status, 0, `stress exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /all 1 runs passed/);
});

// ---------- AC-4 ----------
test('F90 AC-4: no rules/ directory, not packaged, and no tracked file points at it', () => {
  const dir = ['rul', 'es'].join('');
  assert.equal(fs.existsSync(path.join(REPO, dir)), false, `${dir}/ still exists`);
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!pkg.files.includes(`${dir}/`), `package.json files lists ${dir}/`);

  // A reference to the repository's directory: `rules/` not part of a longer path segment
  // (`.claude/rules/` in a v1 project is a different directory).
  const ref = new RegExp(`(^|[^\\w./-])${dir}/`, 'm');
  const files = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).stdout.split('\0')
    .filter((f) => f && !f.startsWith('.harness/'));
  assert.ok(files.length > 10, 'git ls-files lists the repository');
  const hits = [];
  for (const f of files) {
    const p = path.join(REPO, f);
    if (!fs.existsSync(p)) continue; // deleted in the working tree, not yet staged
    const text = fs.readFileSync(p, 'utf8');
    text.split('\n').forEach((line, i) => { if (ref.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`); });
  }
  assert.deepEqual(hits, []);
});

// ---------- AC-5 ----------
test('F90 AC-5: every git call verify makes carries -c core.fsmonitor=false', async () => {
  if (!POSIX) return; // the fake git is a shebang script
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0].trim();
  const bin = fs.realpathSync(tmpdir('harness-f90-git-'));
  const log = path.join(bin, 'calls.log');
  // One record per call: arguments separated by \037, the record ended by \036.
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
{ for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\036'; } >> "${log}"
exec "${realGit}" "$@"
`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);

  const dir = gitRepo({
    '.harness/config.json': { profile: 'sdlc', base_branch: 'main', verify: { commands: [] } },
    '.harness/features.json': { features: [{ id: 'F9', title: 'fixture', status: 'approved', depends_on: [] }] },
    '.harness/contracts/F9.json': {
      id: 'F9', title: 'fixture', security_tier: 'standard', version: 1,
      acceptance_criteria: [{ id: 'AC-1', criterion: 'marker', check: 'node scripts/has-marker.mjs', new: true }],
      security_criteria: [], error_scenarios: [], out_of_scope: [],
    },
    '.harness/backlog.json': { items: [] },
    'scripts/has-marker.mjs': "import fs from 'node:fs';\nprocess.exit(fs.existsSync('marker.txt') ? 0 : 1);\n",
  });
  writeFiles(dir, { 'marker.txt': 'feature\n' });
  commitAll(dir, 'feature');

  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const saved = process.env[key];
  process.env[key] = `${bin}${path.delimiter}${saved}`;
  try {
    const config = resolveConfig({ base_branch: 'main', verify: { commands: [] } });
    await verify({ root: dir, featureId: 'F9', base: 'main', config, cpus: 1 });
  } finally { process.env[key] = saved; }

  const calls = fs.readFileSync(log, 'utf8').split('\x1e').filter(Boolean).map((c) => c.split('\x1f').slice(0, -1));
  // verify's own git runner gives each call a fresh empty hooks directory.
  const verifyCalls = calls.filter((args) => args.some((a) => a.startsWith('core.hooksPath=')));
  assert.ok(verifyCalls.length >= 3, `verify made ${verifyCalls.length} git calls`);
  for (const args of verifyCalls) {
    const i = args.indexOf('core.fsmonitor=false');
    assert.ok(i > 0 && args[i - 1] === '-c', `git ${args.join(' ')} lacks -c core.fsmonitor=false`);
  }
});

// ---------- ES-1 ----------
test('F90 ES-1: every command in --help still loads with a default export function', async () => {
  const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  const names = [...help.stdout.split('commands:')[1].matchAll(/^ {2}([a-z][a-z0-9-]*)\s/gm)].map((m) => m[1]);
  assert.ok(names.length >= 15, `--help lists ${names.length} commands`);
  for (const name of names) {
    const m = await mod(`lib/commands/${name}.mjs`);
    assert.equal(typeof m.default, 'function', `${name}: default export is not a function`);
  }
});
