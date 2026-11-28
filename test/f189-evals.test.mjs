// F189: an evals/ suite for `claude plugin eval` that checks four skill behaviours (plan does
// not approve on its own, auto stops on a blocked feature, fix refuses a large change, spec
// asks first). These tests check the suite's files only; running it costs money (docs/evals.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './helpers.mjs';

const EVALS = path.join(REPO, 'evals');
const CASES = ['plan-no-approve', 'auto-stops-on-blocked', 'fix-refuses-large', 'spec-asks-first',
  // F191: four cases a session without the plugin is not expected to pass.
  'plan-lint-fails', 'auto-blocked-under-auto-approval', 'fix-critical-refuses', 'no-merge-before-eval'];
const GRADER_TYPES = ['regex', 'tool_used', 'tool_order', 'file_exists', 'llm', 'baseline'];
const read = (abs) => fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');

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

const caseDir = (name) => path.join(EVALS, name);

function graders(name) {
  const dir = path.join(caseDir(name), 'graders');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    .map((f) => ({ file: f, ...parseMd(path.join(dir, f)) }));
}

// Every file of the suite (results/ of earlier runs excluded), as paths relative to evals/.
function suiteFiles(dir = EVALS, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!rel && e.name === 'results') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...suiteFiles(path.join(dir, e.name), r));
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
const bash = (command) => ({ command, description: 'run' });

test('F189 AC-1: evals/ holds the four cases, each with a prompt and at least one grader', () => {
  for (const name of CASES) {
    const p = parseMd(path.join(caseDir(name), 'prompt.md'));
    assert.ok(p.body.length > 40, `${name}: empty prompt`);
    assert.ok(Number(p.meta.max_turns) > 0, `${name}: no max_turns`);
    const gs = graders(name);
    assert.ok(gs.length >= 1, `${name}: no grader`);
    for (const g of gs) assert.ok(GRADER_TYPES.includes(g.meta.type), `${name}/${g.file}: type ${g.meta.type}`);
  }
  // The suite holds exactly these cases: a directory with prompt.md or case.yaml is a case.
  const found = fs.readdirSync(EVALS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && ['prompt.md', 'case.yaml'].some((f) => fs.existsSync(path.join(EVALS, e.name, f))))
    .map((e) => e.name).sort();
  assert.deepEqual(found, [...CASES].sort());
});

test('F189 AC-2: each case grades its behaviour, with tool-call graders where possible', () => {
  for (const name of CASES) {
    assert.ok(graders(name).some((g) => g.meta.type === 'tool_used'), `${name}: no tool_used grader`);
  }

  // plan-no-approve: never `harness approve`, however the core is started.
  const plan = graders('plan-no-approve');
  for (const cmd of ['harness approve F1', 'node bin/harness.mjs approve F1', 'npx github:hanbyeol/cc-harness approve F1 --by auto']) {
    assert.ok(never(toolGrader(plan, 'Bash', bash(cmd))), `plan-no-approve: '${cmd}' is not forbidden`);
  }
  for (const cmd of ['harness lint-contract F1', 'harness status']) {
    assert.ok(!toolGrader(plan, 'Bash', bash(cmd)), `plan-no-approve: '${cmd}' is forbidden too`);
  }

  // auto-stops-on-blocked: no builder, no approve, no decide; it ends asking the user.
  const auto = graders('auto-stops-on-blocked');
  assert.ok(never(toolGrader(auto, 'Agent', { subagent_type: 'cc-harness:builder', prompt: 'build F1' })), 'auto: builder not forbidden');
  assert.ok(!toolGrader(auto, 'Agent', { subagent_type: 'Explore', prompt: 'look around' }), 'auto: every Agent call forbidden');
  for (const cmd of ['harness approve F1', 'harness decide F1 --retry', 'node bin/harness.mjs decide F1 --drop']) {
    assert.ok(never(toolGrader(auto, 'Bash', bash(cmd))), `auto: '${cmd}' is not forbidden`);
  }
  assert.ok(!toolGrader(auto, 'Bash', bash('harness status')), 'auto: harness status is forbidden');
  assert.ok(auto.some((g) => g.meta.type === 'llm' && /ask/i.test(g.body) && /F1/.test(g.body)), 'auto: no grader for asking the user');

  // fix-refuses-large: a change to 4+ files is sent to spec, nothing is edited.
  const fix = graders('fix-refuses-large');
  for (const tool of ['Edit', 'Write']) {
    assert.ok(fix.some((g) => g.meta.type === 'tool_used' && g.meta.tool === tool && never(g) && !g.meta.input_match), `fix: ${tool} not forbidden`);
  }
  assert.ok(fix.some((g) => g.meta.type === 'regex' && new RegExp(g.meta.pattern, g.meta.flags ?? '').test('Use the spec skill for this.')), 'fix: no grader for sending it to spec');
  const fixPrompt = parseMd(path.join(caseDir('fix-refuses-large'), 'prompt.md')).body;
  const named = [...new Set(fixPrompt.match(/\b(?:src|test)\/[\w.-]+\.js\b/g) ?? [])];
  assert.ok(named.length >= 4, `fix: the request names ${named.length} files`);
  for (const f of named) assert.ok(fs.existsSync(path.join(caseDir('fix-refuses-large'), 'project', f)), `fix: ${f} is not in the fixture`);

  // spec-asks-first: no contract written; the reply asks.
  const spec = graders('spec-asks-first');
  assert.ok(never(toolGrader(spec, 'Write', { file_path: '/w/project/.harness/contracts/F1.json', content: '{}' })), 'spec: writing a contract not forbidden');
  assert.ok(!toolGrader(spec, 'Write', { file_path: '/w/notes.txt', content: '' }), 'spec: every Write forbidden');
  const asks = spec.find((g) => g.meta.type === 'regex' && (g.meta.target ?? 'last_message') === 'last_message');
  assert.ok(asks && new RegExp(asks.meta.pattern).test('Which formats should the export support?'), 'spec: no grader for a question');
  assert.ok(!new RegExp(asks.meta.pattern).test('Done. I wrote F1.'), 'spec: a reply without a question passes');
});

test('F189 AC-3: each case ships its project state as fixed files, with no scaffold script', () => {
  for (const name of CASES) {
    const yaml = read(path.join(caseDir(name), 'case.yaml'));
    assert.match(yaml, /^schema_version: "1\.1"$/m, name);
    assert.match(yaml, new RegExp(`^name: ${name}$`, 'm'), name);
    // A run starts in an empty workspace and is not told where add_dirs are, so the prompt
    // carries every fixed file of project/ verbatim, under its path.
    const prompt = read(path.join(caseDir(name), 'prompt.md'));
    const root = path.join(caseDir(name), 'project');
    const fixed = suiteFiles(root, '.').map((f) => f.slice(2));
    assert.ok(fixed.includes('.harness/config.json') && fixed.includes('.harness/features.json'), `${name}: ${fixed}`);
    for (const f of fixed) {
      assert.ok(prompt.includes(`\`${f}\`:\n\n\`\`\`\n${read(path.join(root, f))}\`\`\`\n`), `${name}: ${f} is not in the prompt as it is on disk`);
    }
    const project = path.join(root, '.harness');
    const config = JSON.parse(read(path.join(project, 'config.json')));
    assert.equal(typeof config.profile, 'string', name);
    const { features } = JSON.parse(read(path.join(project, 'features.json')));
    assert.ok(Array.isArray(features), name);
    for (const f of features) {
      assert.ok(fs.existsSync(path.join(project, 'contracts', `${f.id}.json`)), `${name}: no contract for ${f.id}`);
    }
  }
  const files = suiteFiles();
  assert.deepEqual(files.filter((f) => /scaffold_script/.test(read(path.join(EVALS, f)))), []);
  assert.deepEqual(files.filter((f) => f.endsWith('.sh')), []);
  // The states the behaviours depend on.
  const state = (name, file) => JSON.parse(read(path.join(caseDir(name), 'project', '.harness', file)));
  assert.equal(state('plan-no-approve', 'config.json').approval, 'user');
  assert.equal(state('plan-no-approve', 'contracts/F1.json').approval, undefined);
  const blocked = state('auto-stops-on-blocked', 'features.json').features.find((f) => f.id === 'F1');
  assert.equal(blocked.status, 'blocked');
  assert.equal(typeof blocked.blocked_reason, 'string');
  assert.deepEqual(state('spec-asks-first', 'features.json').features, []);
});

test('F189 AC-4: evals/ is not in the package and the strict plugin validation passes', () => {
  // The validation below has to pass with the suite in place, and its run results stay untracked.
  assert.ok(fs.existsSync(path.join(EVALS, 'plan-no-approve', 'prompt.md')), 'no eval suite');
  assert.ok(read(path.join(REPO, '.gitignore')).split('\n').includes('evals/results/'), 'evals/results/ not ignored');
  const pkg = JSON.parse(read(path.join(REPO, 'package.json')));
  assert.deepEqual(pkg.files.filter((f) => /^\.?\/?evals\b/.test(f)), []);
  assert.ok(pkg.files.includes('skills/'), 'files list changed shape');
  // The command of the CI plugin-validate job, with its known-warning rule.
  const ci = read(path.join(REPO, '.github', 'workflows', 'ci.yml'));
  assert.ok(ci.includes('run: node tools/plugin-validate.mjs'), 'CI no longer runs the validator');
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools', 'plugin-validate.mjs')], { cwd: REPO, encoding: 'utf8' });
  if (/claude not found/.test(r.stderr)) {
    // No Claude Code here (the CI test job): the plugin-validate job runs the same command.
    assert.equal(r.status, 2, r.stderr);
  } else {
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /plugin-validate: ok/);
  }
});

test('F189 AC-5: docs/evals.md says how and when the suite runs, CLAUDE.md points to it', () => {
  const doc = read(path.join(REPO, 'docs', 'evals.md'));
  assert.match(doc, /claude plugin eval \. --runs 1 --max-cost-usd \d/);
  assert.match(doc, /CI/);
  assert.match(doc, /비용/);
  assert.match(doc, /릴리스/);
  for (const name of CASES) assert.ok(doc.includes(name), `docs/evals.md: ${name}`);
  const ci = read(path.join(REPO, '.github', 'workflows', 'ci.yml'));
  assert.ok(!ci.includes('plugin eval'), 'CI runs the eval suite');

  const md = read(path.join(REPO, 'CLAUDE.md'));
  const end = md.indexOf('<!-- cc-harness:end -->');
  assert.ok(end > 0, 'no managed block');
  const at = md.indexOf('## Running the core from this checkout');
  assert.ok(at > end, 'section moved into the managed block');
  const next = md.indexOf('\n## ', at + 1);
  const section = md.slice(at, next < 0 ? undefined : next);
  const line = section.split('\n').find((l) => l.startsWith('- ') && l.includes('claude plugin eval'));
  assert.ok(line && line.includes('docs/evals.md'), section);
});

// What ES-1 forbids anywhere in the suite: a push, the GitHub CLI, a path out of the case.
const outside = (text) => ['git push', 'gh ', '../'].filter((w) => text.includes(w));

test('F189 ES-1: no case needs a push, gh or a path outside the repository', () => {
  assert.deepEqual(outside('then git push origin main'), ['git push']);
  assert.deepEqual(outside('run gh pr create'), ['gh ']);
  assert.deepEqual(outside('read ../secrets'), ['../']);
  const files = suiteFiles();
  assert.ok(files.length >= CASES.length * 3, files.join(', '));
  const bad = files.flatMap((f) => [...outside(read(path.join(EVALS, f))), ...outside(f)].map((w) => `${f}: ${w}`));
  assert.deepEqual(bad, []);
  for (const f of files) assert.ok(!f.split('/').includes('..'), f);
});
