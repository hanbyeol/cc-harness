#!/usr/bin/env node
// Criterion check runner: `node test/t.mjs "F3 AC-1"`.
// Runs only tests whose name starts with the given id and FAILS when none match.
// (node --test with a non-matching --test-name-pattern still exits 0 — a vacuous pass.)
// Only the test files whose source contains the id are loaded; when no file does (a name
// built from a template), every test file is, as before.
// Self-contained: it imports only node: built-ins, so copying this one file is enough.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// test/**/*.test.mjs under `root` (relative, '/'-separated, sorted) whose source contains
// `id`. A file that cannot be read is included: a missed verdict is worse than a slower run.
export function selectTestFiles(root, id, read = fs.readFileSync) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(`${root}/${rel}`, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith('.test.mjs')) {
        let src;
        try { src = read(`${root}/${child}`, 'utf8'); } catch { out.push(child); continue; }
        if (src.includes(id)) out.push(child);
      }
    }
  };
  walk('test');
  return out;
}

// True when this file is the entry point, not imported by a test.
function isMain() {
  if (!process.argv[1]) return false;
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
}

function main() {
  const id = process.argv[2];
  if (!id) {
    console.error('usage: node test/t.mjs "<F1 AC-1>"');
    process.exit(2);
  }
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = `^${escaped}\\b`;
  const re = new RegExp(pattern);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = selectTestFiles(root, id);

  const res = spawnSync(process.execPath,
    ['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`,
      ...(files.length > 0 ? files : ['test/**/*.test.mjs'])],
    // NODE_TEST_CONTEXT (set when t.mjs itself runs under node --test) switches the
    // nested runner to a child protocol with no TAP on stdout — drop it.
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });

  let matched = 0;
  let failed = 0;
  for (const line of (res.stdout || '').split('\n')) {
    const m = /^\s*(not ok|ok) \d+ - (.*?)(\s+# (SKIP|TODO)\b.*)?$/.exec(line);
    if (!m || !re.test(m[2])) continue;
    matched += 1;
    if (m[1] === 'not ok' || m[3]) failed += 1;
  }

  if (matched === 0) {
    console.error(`t.mjs: no test matched "${id}" — criterion has no check (vacuous)`);
    process.exit(1);
  }
  if (failed > 0 || res.status !== 0) {
    process.stdout.write(res.stdout || '');
    process.stderr.write(res.stderr || '');
    console.error(`t.mjs: "${id}" — ${failed}/${matched} failed (runner exit ${res.status})`);
    process.exit(1);
  }
  console.log(`t.mjs: "${id}" — ${matched} passed`);
}

if (isMain()) main();
