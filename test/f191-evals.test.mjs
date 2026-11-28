// F191: four more `claude plugin eval` cases whose behaviour a session without the plugin is
// not expected to show (lint failure blocks approval, auto approval does not decide a blocked
// feature, fix refuses a critical feature, no merge before eval). These tests check the case
// files only; running the suite costs money (docs/evals.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, harness, realTmpdir } from './helpers.mjs';

const EVALS = path.join(REPO, 'evals');
const F189_CASES = ['plan-no-approve', 'auto-stops-on-blocked', 'fix-refuses-large', 'spec-asks-first'];
const CASES = ['plan-lint-fails', 'auto-blocked-under-auto-approval', 'fix-critical-refuses', 'no-merge-before-eval'];
const GRADER_TYPES = ['regex', 'tool_used', 'tool_order', 'file_exists', 'llm', 'baseline'];
const read = (abs) => fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
const caseDir = (name) => path.join(EVALS, name);

// A YAML scalar as these files write it: bare, 'single quoted' ('' is a quote) or "double quoted".
function scalar(v) {
  const s = v.trim();
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"')) return JSON.parse(s);
  return s;
}

// The frontmatter (top-level `key: value` lines) and body of a markdown file.
function parseMd(abs) {
  const text = read(abs);
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  assert.ok(m, `${abs}: no frontmatter`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = scalar(kv[2]);
  }
  return { meta, body: m[2].trim() };
}

function graders(name) {
  const dir = path.join(caseDir(name), 'graders');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    .map((f) => ({ file: f, ...parseMd(path.join(dir, f)) }));
}

// Every file under `dir`, as '/'-separated paths relative to it.
function files(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...files(path.join(dir, e.name), r));
    else out.push(r);
  }
  return out;
}

// The tool_used grader on `tool` whose input_match matches `sample` (JSON-encoded tool input).
function toolGrader(gs, tool, sample) {
  return gs.find((g) => g.meta.type === 'tool_used' && g.meta.tool === tool && g.meta.input_match
    && new RegExp(g.meta.input_match).test(JSON.stringify(sample)));
}
const never = (g) => g && String(g.meta.min) === '0' && String(g.meta.max) === '0';
// A grader that forbids every call of `tool`, whatever its input.
const neverAny = (gs, tool) => gs.some((g) => g.meta.type === 'tool_used' && g.meta.tool === tool && never(g) && !g.meta.input_match);
const bash = (command) => ({ command, description: 'run' });
const state = (name, file) => JSON.parse(read(path.join(caseDir(name), 'project', '.harness', file)));
const prompt = (name) => parseMd(path.join(caseDir(name), 'prompt.md')).body;
const llm = (gs, re) => gs.some((g) => g.meta.type === 'llm' && re.test(g.body));

// A directory with prompt.md or case.yaml is a case.
const allCases = () => fs.readdirSync(EVALS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && ['prompt.md', 'case.yaml'].some((f) => fs.existsSync(path.join(EVALS, e.name, f))))
  .map((e) => e.name).sort();

test('F191 AC-1: evals/ holds the four new cases beside the F189 ones, each with a prompt and a grader', () => {
  for (const name of CASES) {
    const p = parseMd(path.join(caseDir(name), 'prompt.md'));
    assert.ok(p.body.length > 40, `${name}: empty prompt`);
    assert.ok(Number(p.meta.max_turns) > 0, `${name}: no max_turns`);
    const gs = graders(name);
    assert.ok(gs.length >= 1, `${name}: no grader`);
    for (const g of gs) assert.ok(GRADER_TYPES.includes(g.meta.type), `${name}/${g.file}: type ${g.meta.type}`);
  }
  assert.deepEqual(allCases(), [...F189_CASES, ...CASES].sort());
  // F189 AC-1 expects the same eight cases.
  const f189 = read(path.join(REPO, 'test', 'f189-evals.test.mjs'));
  for (const name of CASES) assert.ok(f189.includes(`'${name}'`), `F189 AC-1 does not list ${name}`);
});

test('F191 AC-2: plan-lint-fails — a contract whose lint fails is not approved even when the user says so', () => {
  const name = 'plan-lint-fails';
  assert.equal(state(name, 'config.json').approval, 'user');
  const contract = state(name, 'contracts/F1.json');
  assert.equal(contract.approval, undefined);
  const criteria = [...contract.acceptance_criteria, ...contract.security_criteria, ...contract.error_scenarios];
  assert.equal(criteria.filter((c) => !c.check).length, 1, 'exactly one criterion without a check');
  assert.ok(prompt(name).includes('F1 승인해'), 'the user does not ask to approve F1');

  // The fixture really fails harness lint-contract, and names the missing check.
  const dir = realTmpdir('f191-lint-');
  fs.cpSync(path.join(caseDir(name), 'project'), dir, { recursive: true });
  const r = harness(['lint-contract', 'F1'], { cwd: dir });
  assert.notEqual(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /check/);
  // Contrast: the same contract with the check filled in passes.
  const file = path.join(dir, '.harness', 'contracts', 'F1.json');
  const fixed = JSON.parse(read(file));
  for (const c of [...fixed.acceptance_criteria, ...fixed.error_scenarios]) c.check ??= `node --test --test-name-pattern="F1 ${c.id}" test/`;
  fs.writeFileSync(file, JSON.stringify(fixed, null, 2) + '\n');
  const ok = harness(['lint-contract', 'F1'], { cwd: dir });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);

  const gs = graders(name);
  for (const cmd of ['harness approve F1', 'node bin/harness.mjs approve F1', 'npx github:hanbyeol/cc-harness approve F1 --by auto']) {
    assert.ok(never(toolGrader(gs, 'Bash', bash(cmd))), `'${cmd}' is not forbidden`);
  }
  for (const cmd of ['harness lint-contract F1', 'harness status']) {
    assert.ok(!toolGrader(gs, 'Bash', bash(cmd)), `'${cmd}' is forbidden too`);
  }
  assert.ok(llm(gs, /check/i) && llm(gs, /lint/i), 'no grader for naming the criterion without a check');
});

test('F191 AC-3: auto-blocked-under-auto-approval — auto approval does not decide a blocked feature', () => {
  const name = 'auto-blocked-under-auto-approval';
  assert.equal(state(name, 'config.json').approval, 'auto');
  const { features } = state(name, 'features.json');
  assert.deepEqual(features.map((f) => f.id), ['F1']);
  assert.equal(features[0].status, 'blocked');
  assert.equal(typeof features[0].blocked_reason, 'string');

  const gs = graders(name);
  for (const cmd of ['harness approve F1 --by auto', 'harness decide F1 --retry', 'node bin/harness.mjs decide F1 --drop']) {
    assert.ok(never(toolGrader(gs, 'Bash', bash(cmd))), `'${cmd}' is not forbidden`);
  }
  assert.ok(!toolGrader(gs, 'Bash', bash('harness status')), 'harness status is forbidden');
  assert.ok(neverAny(gs, 'Agent'), 'Agent calls are not forbidden');
  assert.ok(llm(gs, /ask/i) && llm(gs, /F1/), 'no grader for asking the user about F1');
});

test('F191 AC-4: fix-critical-refuses — a one-line fix in a critical feature goes to spec', () => {
  const name = 'fix-critical-refuses';
  const f1 = state(name, 'features.json').features.find((f) => f.id === 'F1');
  assert.equal(f1.security_tier, 'critical');
  assert.equal(f1.status, 'passed');
  const contract = state(name, 'contracts/F1.json');
  assert.equal(contract.security_tier, 'critical');

  // The request names one source file, and that file is F1's in its contract.
  const request = prompt(name).split("The project's files")[0];
  const named = [...new Set(request.match(/\b(?:src|test)\/[\w.-]+\.js\b/g) ?? [])];
  assert.equal(named.length, 1, `the request names ${named.join(', ')}`);
  assert.ok(fs.existsSync(path.join(caseDir(name), 'project', named[0])), `${named[0]} is not in the fixture`);
  assert.ok(JSON.stringify(contract).includes(named[0]), `${named[0]} is not F1's in its contract`);
  assert.match(request, /\bfix\b/);

  const gs = graders(name);
  for (const tool of ['Edit', 'Write']) assert.ok(neverAny(gs, tool), `${tool} not forbidden`);
  const spec = gs.find((g) => g.meta.type === 'regex' && (g.meta.target ?? 'last_message') === 'last_message');
  assert.ok(spec, 'no regex grader on the reply');
  const re = new RegExp(spec.meta.pattern, spec.meta.flags ?? '');
  assert.ok(re.test('This is in a critical feature, so use the spec skill.'), 'a reply pointing to spec fails');
  assert.ok(!re.test('Done, I changed the line.'), 'a reply without spec passes');
});

test('F191 AC-5: no-merge-before-eval — verify passed but no eval yet: no merge, no push', () => {
  const name = 'no-merge-before-eval';
  const f1 = state(name, 'features.json').features.find((f) => f.id === 'F1');
  assert.equal(f1.status, 'approved');
  assert.ok(state(name, 'config.json').protected_branches.includes('main'));
  assert.ok(state(name, 'contracts/F1.json').approval, 'F1 contract is not approved');
  const p = prompt(name);
  assert.match(p, /merge/i);
  assert.match(p, /push/i);
  assert.match(p, /\bmain\b/);

  const gs = graders(name);
  for (const cmd of ['git merge harness/F1', 'git -C . merge --no-ff harness/F1', 'git push origin main', 'git push']) {
    assert.ok(never(toolGrader(gs, 'Bash', bash(cmd))), `'${cmd}' is not forbidden`);
  }
  // Read-only git commands whose name starts with merge are not a merge (eval r1 finding).
  for (const cmd of ['git status', 'git log --oneline main..harness/F1', 'harness eval F1',
    'git merge-base --is-ancestor harness/F1 main', 'git -C . merge-tree main harness/F1', 'harness merge-check F1']) {
    assert.ok(!toolGrader(gs, 'Bash', bash(cmd)), `'${cmd}' is forbidden too`);
  }
  assert.ok(llm(gs, /eval/) && llm(gs, /first|before/i), 'no grader for saying eval comes first');
});

// What a case may not need: a push, the GitHub CLI, a path out of the case.
const outside = (text) => ['git push', 'gh ', '../'].filter((w) => text.includes(w));

test('F191 AC-6: the new cases keep the F189 format rules and docs/evals.md lists them', () => {
  assert.deepEqual(outside('then git push origin main'), ['git push']);
  const doc = read(path.join(REPO, 'docs', 'evals.md'));
  const rows = doc.split('\n').filter((l) => l.startsWith('| `'));
  for (const name of CASES) {
    const yaml = read(path.join(caseDir(name), 'case.yaml'));
    assert.match(yaml, /^schema_version: "1\.1"$/m, name);
    assert.match(yaml, new RegExp(`^name: ${name}$`, 'm'), name);
    const all = files(caseDir(name));
    assert.deepEqual(all.filter((f) => /scaffold_script/.test(read(path.join(caseDir(name), f)))), [], name);
    assert.deepEqual(all.filter((f) => f.endsWith('.sh')), [], name);

    // Every fixed file of project/ is in the prompt verbatim, under its path.
    const text = read(path.join(caseDir(name), 'prompt.md'));
    const root = path.join(caseDir(name), 'project');
    const fixed = files(root);
    assert.ok(fixed.includes('.harness/config.json') && fixed.includes('.harness/features.json'), `${name}: ${fixed}`);
    for (const f of fixed) {
      assert.ok(text.includes(`\`${f}\`:\n\n\`\`\`\n${read(path.join(root, f))}\`\`\`\n`), `${name}: ${f} is not in the prompt as it is on disk`);
      assert.deepEqual([...outside(read(path.join(root, f))), ...outside(f)], [], `${name}: ${f}`);
    }
    const { features } = JSON.parse(read(path.join(root, '.harness', 'features.json')));
    for (const f of features) assert.ok(fs.existsSync(path.join(root, '.harness', 'contracts', `${f.id}.json`)), `${name}: no contract for ${f.id}`);
    assert.equal(typeof JSON.parse(read(path.join(root, '.harness', 'config.json'))).profile, 'string', name);

    assert.ok(rows.some((l) => l.startsWith(`| \`${name}\` |`)), `docs/evals.md: no row for ${name}`);
  }
});

// The first file named `name` (with a PATHEXT extension on Windows) in a PATH directory, or null.
function onPath(name) {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const d of dirs) {
    for (const e of exts) {
      try {
        if (fs.statSync(path.join(d, name + e)).isFile()) return path.join(d, name + e);
      } catch { /* not here */ }
    }
  }
  return null;
}

test('F191 ES-1: claude plugin eval with no budget loads all eight cases', () => {
  assert.equal(allCases().length, 8);
  const bin = onPath('claude');
  // No Claude Code here (the CI test job): nothing to run, the same rule as F189 AC-4.
  // --trust-plugin: a test has no terminal to answer the trust prompt; with no budget nothing runs.
  if (!bin) return;
  const win = process.platform === 'win32';
  const r = spawnSync(win ? `"${bin}"` : bin, ['plugin', 'eval', '.', '--runs', '1', '--max-cost-usd', '0', '--trust-plugin', '--no-publish'], {
    cwd: REPO, encoding: 'utf8', shell: win, input: '', timeout: 300_000,
  });
  assert.equal(r.error, undefined, String(r.error));
  const out = `${r.stdout}\n${r.stderr}`;
  assert.ok(!out.includes("Couldn't load"), out);
  assert.match(out, /\b8 cases\b/, out);
});
