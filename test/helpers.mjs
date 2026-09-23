import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(REPO, 'bin', 'harness.mjs');

export function tmpdir(prefix = 'harness-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
