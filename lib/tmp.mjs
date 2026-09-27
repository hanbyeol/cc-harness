// Temporary directories the core creates (harness-base-*, harness-no-hooks-*; SPEC §8).
// The owner removes each one when it is done with it. Whatever is still registered when the
// process exits — an error path, or a SIGINT that ends the process while a step runs — is
// removed synchronously on 'exit', so a verify or run never leaves them behind in $TMPDIR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const live = new Set();
let hooked = false;

/** A new directory `<os.tmpdir()>/<prefix>XXXXXX`, removed at process exit unless removed before. */
export function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  live.add(dir);
  if (!hooked) {
    hooked = true;
    process.on('exit', removeAllTempDirs);
  }
  return dir;
}

/** Removes a directory from makeTempDir (best effort) and forgets it. */
export function removeTempDir(dir) {
  live.delete(dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Runs `fn(dir)` with a new empty directory `harness-no-hooks-*` — the core.hooksPath of one
 * verify/eval git call (SPEC §6) — and removes it when `fn` settles.
 */
export async function withNoHooksDir(fn) {
  const dir = makeTempDir('harness-no-hooks-');
  try {
    return await fn(dir);
  } finally {
    removeTempDir(dir);
  }
}

function removeAllTempDirs() {
  for (const dir of [...live]) removeTempDir(dir);
}
