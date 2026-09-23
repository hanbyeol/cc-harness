import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HarnessError } from './errors.mjs';

export const HARNESS_DIR = '.harness';

export function paths(root) {
  const dir = path.join(root, HARNESS_DIR);
  return {
    dir,
    config: path.join(dir, 'config.json'),
    features: path.join(dir, 'features.json'),
    backlog: path.join(dir, 'backlog.json'),
    contracts: path.join(dir, 'contracts'),
    verdicts: path.join(dir, 'verdicts'),
    runs: path.join(dir, 'runs'),
    worktrees: path.join(dir, 'wt'),
    contract: (id) => path.join(dir, 'contracts', `${id}.json`),
  };
}

export function isInitialized(root) {
  return fs.existsSync(paths(root).dir);
}

// Reads and parses a JSON state file. Corruption is never "repaired" by
// guessing — the caller stops and the user fixes the file (SPEC E6).
export function readJson(file, { optional = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      if (optional) return undefined;
      throw new HarnessError(`${file}: not found`, { code: 'missing' });
    }
    throw new HarnessError(`${file}: cannot read (${e.code})`, { code: 'io' });
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new HarnessError(`${file}: invalid JSON — ${e.message}. Fix or restore the file; harness will not modify it.`, { code: 'state_corrupt' });
  }
}

// Atomic write: temp file in the same directory, then rename over the target.
// `fsImpl` is injectable so tests can simulate a failure between the two steps.
export function writeJsonAtomic(file, data, { fsImpl = fs } = {}) {
  const text = JSON.stringify(data, null, 2) + '\n';
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    // A failure part-way through writing (e.g. ENOSPC) must not leave the temp file behind.
    fsImpl.writeFileSync(tmp, text);
    fsImpl.renameSync(tmp, file);
  } catch (e) {
    try { fsImpl.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw new HarnessError(`${file}: write failed (${e.code || e.message}); previous content kept`, { code: 'io' });
  }
}

export function loadFeatures(root) {
  const data = readJson(paths(root).features);
  if (!data || !Array.isArray(data.features)) {
    throw new HarnessError(`${paths(root).features}: expected { "features": [...] }`, { code: 'state_corrupt' });
  }
  data.features.forEach((f, i) => {
    const bad = f === null || typeof f !== 'object' || Array.isArray(f)
      ? 'is not an object'
      : ['id', 'status', 'title'].filter((k) => typeof f[k] !== 'string').map((k) => `'${k}'`).join(', ');
    if (bad) {
      const detail = bad.startsWith('is ') ? bad : `has a missing or non-string ${bad}`;
      throw new HarnessError(`${paths(root).features}: features[${i}] ${detail}. Fix or restore the file; harness will not modify it.`, { code: 'state_corrupt' });
    }
  });
  return data;
}

export function saveFeatures(root, data) {
  writeJsonAtomic(paths(root).features, data);
}

// Features whose status is `approved` and whose dependencies have all passed.
export function runnableFeatures(features) {
  const byId = new Map(features.map((f) => [f.id, f]));
  return features.filter((f) => f.status === 'approved'
    && (f.depends_on || []).every((d) => byId.get(d)?.status === 'passed'));
}
