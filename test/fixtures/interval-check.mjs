#!/usr/bin/env node
// A criterion check / test_count command for F26 tests that records when and where it ran.
// usage: node interval-check.mjs <log> <id> [--ms N] [--exit N] [--base-exit N]
//          [--fail-if-overlap] [--probe <rel>] [--print N] [--await-other-side]
// Appends JSON lines to <log>: {ev:'start'|'end', id, side, cwd, t, probe?, overlap?}.
// side is 'head' when .git is a directory (the main checkout) and 'base' when it is a file
// (a linked worktree). --base-exit is the exit code on base (default: --exit).
// --fail-if-overlap exits 1 when another run in the log was active during this one.
// --probe records whether <rel> exists in cwd at start. --print writes N as the last stdout line.
// --await-other-side waits (up to 20 s) until a run of the same id on the other side has
// started, so concurrent runs overlap by construction rather than by timing.
import fs from 'node:fs';

const [log, id, ...rest] = process.argv.slice(2);
const opt = (name, def) => {
  const i = rest.indexOf(name);
  return i === -1 ? def : rest[i + 1];
};
const ms = Number(opt('--ms', '0'));
const side = fs.statSync('.git').isDirectory() ? 'head' : 'base';
const exitHead = Number(opt('--exit', '0'));
const code = side === 'base' ? Number(opt('--base-exit', String(exitHead))) : exitHead;
const probe = opt('--probe', null);
const cwd = fs.realpathSync(process.cwd());
const write = (ev) => fs.appendFileSync(log, `${JSON.stringify(ev)}\n`);

const start = Date.now();
write({ ev: 'start', id, side, cwd, t: start, pid: process.pid, ...(probe ? { probe: fs.existsSync(probe) } : {}) });
const otherStarted = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .some((e) => e.ev === 'start' && e.id === id && e.side !== side);
const ready = async () => {
  if (!rest.includes('--await-other-side')) return;
  for (const t0 = Date.now(); !otherStarted() && Date.now() - t0 < 20_000;) await new Promise((res) => setTimeout(res, 20));
};
await ready();
setTimeout(() => {
  const end = Date.now();
  let status = code;
  if (rest.includes('--fail-if-overlap')) {
    const events = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const ends = new Map(events.filter((e) => e.ev === 'end').map((e) => [e.pid, e.t]));
    const overlap = events.some((e) => e.ev === 'start' && e.pid !== process.pid
      && e.t <= end && (ends.get(e.pid) ?? Infinity) >= start);
    if (overlap) status = 1;
  }
  write({ ev: 'end', id, side, cwd, t: end, pid: process.pid, code: status });
  if (opt('--print', null) !== null) console.log(opt('--print', null));
  process.exit(status);
}, ms);
