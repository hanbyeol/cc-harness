// System sleep during `harness run` (SPEC §8): keep the machine awake while the run lasts,
// and tell a step that timed out because the machine slept from one that was really too slow.
import { spawn } from 'node:child_process';

export const SLEEP_THRESHOLD_MS = 60_000; // a gap this long counts as system sleep
const SETTLE_MS = 150; // an inhibitor that exits within this long after start did not take
const TICK_MS = 5_000;

// Linux: systemd-inhibit holds its lock while its command runs. The command is this node
// binary waiting for the run's pid to disappear, so the lock also ends if the run is killed.
const WATCH_PARENT = 'const p=Number(process.argv[1]);setInterval(()=>{try{process.kill(p,0)}catch{process.exit(0)}},1000)';

/**
 * The inhibitor command for a platform — fixed names and arguments only (SC-2): nothing
 * from config or the features goes in. null where the harness does not inhibit sleep.
 */
export function inhibitorCommand(platform, pid) {
  if (platform === 'darwin') return { file: 'caffeinate', args: ['-i', '-w', String(pid)] };
  if (platform === 'linux') {
    return {
      file: 'systemd-inhibit',
      args: ['--what=idle:sleep', '--mode=block', '--who=cc-harness', '--why=harness run in progress',
        process.execPath, '-e', WATCH_PARENT, String(pid)],
    };
  }
  return null;
}

/**
 * Starts the sleep inhibitor (no shell, PATH lookup of the fixed name).
 * @param {{platform?:string, pid?:number, env?:object, onLost?:(why:string)=>void}} opts
 *   onLost is called once if the inhibitor exits later, before stop().
 * @returns {Promise<{ok:boolean, label:string, stop:()=>void}>} ok false: `label` says why it is unavailable.
 */
export async function startSleepInhibitor({ platform = process.platform, pid = process.pid, env = process.env, onLost = () => {} } = {}) {
  const cmd = inhibitorCommand(platform, pid);
  const none = (why) => ({ ok: false, label: why, stop: () => {} });
  if (!cmd) return none(`not supported on ${platform}`);
  let child;
  try {
    child = spawn(cmd.file, cmd.args, { env, stdio: 'ignore', shell: false, detached: true, windowsHide: true });
  } catch (e) {
    return none(`${cmd.file}: ${e.code || e.message}`);
  }
  let gone = null;
  let stopped = false;
  let settled = false;
  const lost = (why) => {
    if (gone) return;
    gone = why;
    if (settled && !stopped) onLost(why);
  };
  child.on('error', (e) => lost(e.code === 'ENOENT' ? `${cmd.file} not found on PATH` : `${cmd.file}: ${e.code || e.message}`));
  child.on('exit', (code, sig) => lost(`${cmd.file} exited (${sig || `exit ${code}`})`));
  child.unref();
  await new Promise((resolve) => {
    const t = setTimeout(resolve, SETTLE_MS);
    const done = () => { clearTimeout(t); resolve(); };
    child.once('error', done);
    child.once('exit', done);
  });
  settled = true;
  if (gone) return none(gone);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    process.off('exit', stop);
    if (gone) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  };
  // A run that leaves through process.exit (second Ctrl-C) still ends the inhibitor.
  process.once('exit', stop);
  return { ok: true, label: `${cmd.file} ${cmd.args.slice(0, platform === 'darwin' ? 3 : 2).join(' ')}`, stop };
}

/**
 * Measures system sleep between two marks. Two signals, the larger wins:
 * - wall clock minus monotonic clock (the monotonic clock stops while the system sleeps);
 * - a ticker whose wall-clock gaps exceed its interval (covers a monotonic clock that kept running).
 */
export function sleepMeter({ now = () => new Date(), monotonic = () => performance.now(), tickMs = TICK_MS } = {}) {
  const wall = () => +now();
  let tickedAt = wall();
  let gapMs = 0; // accumulated wall-clock time the ticker could not account for
  const timer = setInterval(() => {
    const w = wall();
    gapMs += Math.max(0, w - tickedAt - tickMs);
    tickedAt = w;
  }, tickMs);
  timer.unref();
  return {
    mark: () => ({ wall: wall(), mono: monotonic(), gap: gapMs }),
    /** Milliseconds of system sleep since `m`. */
    sleptSince(m) {
      const byClock = (wall() - m.wall) - (monotonic() - m.mono);
      return Math.max(0, byClock, gapMs - m.gap);
    },
    stop: () => clearInterval(timer),
  };
}
