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

function removeAllTempDirs() {
  for (const dir of [...live]) removeTempDir(dir);
}
