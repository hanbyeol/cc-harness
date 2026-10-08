// Verify result cache (SPEC §6.4): a passed verify result stored under a digest of everything
// that decides it — the working tree, the merge-base, the contract, the verify settings, node,
// the platform, the harness version and the environment the commands see — so a verify of the
// same inputs (the post-merge verify of a run, the verify of `harness eval` after
// `harness verify`) returns it without running anything. Only passed results are stored.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { writeJsonAtomic } from './state.mjs';

export const VERIFY_CACHE = 'verify-cache.json';
export const VERIFY_CACHE_LIMIT = 50;

/** sha256 of the key parts; the stored key never holds an environment value in plain text (SC-1). */
export const cacheKey = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// { entries, warning? }: a missing file is an empty cache; an unreadable or malformed one is
// ignored with a warning naming the file (everything runs and the file is written anew).
// Entries that are not objects are dropped.
export function readVerifyCache(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { entries: [] };
    return { entries: [], warning: `verify cache ${file} cannot be read (${e.code || e.message}) — ignored, everything runs` };
  }
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!isObject(data) || !Array.isArray(data.entries)) {
    return { entries: [], warning: `verify cache ${file} is not valid JSON of the expected shape — ignored, everything runs and the file is rewritten` };
  }
  return { entries: data.entries.filter(isObject) };
}

// A stored result is used only when it has the shape of a passed verify result.
function usable(r) {
  return isObject(r) && r.pass === true && Array.isArray(r.commands) && Array.isArray(r.criteria) && Array.isArray(r.warnings)
    && isObject(r.integrity) && Array.isArray(r.integrity.markers) && Array.isArray(r.integrity.harnessPaths) && isObject(r.integrity.testCount);
}

/** The stored result for `key`, or null when there is none or it is not a passed result. */
export function cachedResult(entries, key) {
  const hit = entries.findLast((e) => e.key === key);
  return hit && usable(hit.result) ? hit.result : null;
}

/**
 * Whether a verify result may be stored: it passed, no command passed only on a flaky retry and
 * nothing in it timed out (a command, a head check, a base vacuity run).
 */
export function storable(r) {
  return r.pass === true
    && r.commands.every((c) => !c.flaky_passed && !c.timedOut)
    && r.criteria.every((c) => !c.timedOut && !c.base_timed_out);
}

// Re-reads the file and replaces the key's entry, keeping the newest VERIFY_CACHE_LIMIT
// entries. Returns a warning string when the file cannot be written, else null.
export function storeResult(file, entry) {
  const { entries } = readVerifyCache(file);
  const next = [...entries.filter((e) => e.key !== entry.key), entry].slice(-VERIFY_CACHE_LIMIT);
  try {
    writeJsonAtomic(file, { entries: next });
    return null;
  } catch (e) {
    return `cannot write verify cache ${file}: ${e.message}`;
  }
}
