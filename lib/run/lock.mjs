// The run lock (SPEC §8): .harness/runs/run.lock is created exclusively by a run and removed when
// it ends, so a second `harness run` cannot start a second scheduler on the same state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HarnessError } from '../errors.mjs';

/** True when `pid` is a live process: kill(pid, 0) succeeds or fails with EPERM (SPEC §8). */
export function isProcessAlive(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function locked(lockPath, detail, hint) {
  return new HarnessError(`another run holds ${lockPath} (${detail}) — ${hint}`, { code: 'run_locked' });
}

// Takes the lock for this process; returns a function that removes it (only if it is still ours).
export function acquireRunLock(runsDir, { warn = () => {}, now = () => new Date() } = {}) {
  const lockPath = path.join(runsDir, 'run.lock');
  fs.mkdirSync(runsDir, { recursive: true });
  const host = os.hostname();
  const mine = JSON.stringify({ pid: process.pid, host, startedAt: now().toISOString() });
  const tryCreate = () => {
    try {
      fs.writeFileSync(lockPath, mine, { flag: 'wx' });
      return true;
    } catch (err) {
      if (err?.code === 'EEXIST') return false;
      throw err;
    }
  };
  if (!tryCreate()) {
    let held = null;
    try { held = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { /* unreadable: treated as foreign */ }
    const valid = held !== null && typeof held === 'object' && Number.isInteger(held.pid) && held.pid > 0;
    const detail = valid ? `pid ${held.pid}, host ${held.host}` : 'unreadable lock';
    if (!valid || held.host !== host) {
      throw locked(lockPath, detail, `delete it if no run is active`);
    }
    if (isProcessAlive(held.pid)) {
      throw locked(lockPath, detail, `wait for that run to end, or delete it if no run is active`);
    }
    warn(`stale run lock ${lockPath} (pid ${held.pid} is not running) — taking it over`);
    fs.rmSync(lockPath, { force: true });
    if (!tryCreate()) throw locked(lockPath, detail, `delete it if no run is active`);
  }
  return () => {
    try {
      const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (cur?.pid === process.pid && cur?.startedAt === JSON.parse(mine).startedAt) fs.rmSync(lockPath, { force: true });
    } catch { /* already gone */ }
  };
}
