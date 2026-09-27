import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(REPO, 'bin', 'harness.mjs');

// Temp dirs are removed when the test process exits (node --test runs one process per file):
// left behind, ~240k of them filled $TMPDIR until git could no longer create temp files.
// HARNESS_KEEP_TMP=1 keeps them for debugging.
const created = [];
process.on('exit', () => {
  if (process.env.HARNESS_KEEP_TMP === '1') return;
  for (const d of created) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

export function tmpdir(prefix = 'harness-test-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(d);
  return d;
}

// Runs the real CLI as a child process.
export function harness(args, { cwd, env } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// A project directory with initialized .harness state.
export function project(features = []) {
  const dir = tmpdir();
  harness(['init'], { cwd: dir });
  writeJson(path.join(dir, '.harness', 'features.json'), { features });
  return dir;
}
