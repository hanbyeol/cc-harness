// Static form of F78 AC-5: instead of running every t.mjs check of the F70–F77 contracts, look
// for a test whose name starts with the check's id in the files t.mjs would load for it.
import fs from 'node:fs';
import path from 'node:path';
import { selectTestFiles } from '../test/t.mjs';

// The ids of the `node test/t.mjs "<id>"` checks of contracts F70..F77 under `repo`.
// A contract that cannot be read or parsed fails with its path in the message.
export function t78CheckIds(repo, read = fs.readFileSync) {
  const ids = [];
  for (let n = 70; n <= 77; n++) {
    const file = path.join(repo, '.harness', 'contracts', `F${n}.json`);
    let c;
    try { c = JSON.parse(read(file, 'utf8')); } catch (e) { throw new Error(`cannot read contract ${file}: ${e.message}`); }
    for (const key of ['acceptance_criteria', 'security_criteria', 'error_scenarios']) {
      for (const cr of c[key] || []) {
        const m = /^node test\/t\.mjs "([^"]+)"$/.exec(cr.check);
        if (m) ids.push(m[1]);
      }
    }
  }
  return ids;
}

// True when a file t.mjs selects for `id` (every test file when none does) has a line that
// starts a test whose name starts with `id`.
export function hasTestFor(repo, id, read = fs.readFileSync) {
  let files = selectTestFiles(repo, id, read);
  if (files.length === 0) files = selectTestFiles(repo, '', read);
  const re = new RegExp(`^[ \\t]*test\\(\\s*['"\`]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm');
  return files.some((f) => {
    try { return re.test(read(`${repo}/${f}`, 'utf8')); } catch { return false; }
  });
}
