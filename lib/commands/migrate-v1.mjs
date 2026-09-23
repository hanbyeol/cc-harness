import fs from 'node:fs';
import path from 'node:path';
import { HarnessError } from '../errors.mjs';
import { isInitialized, paths, readJson, writeJsonAtomic } from '../state.mjs';
import init from './init.mjs';

const V1_FILE = path.join('progress', 'feature_list.json');
const V1_CONTRACTS = 'progress/contracts';
const USAGE = 'usage: harness migrate-v1 [--force]';

// v1 tiers were low|standard|critical; v2 knows only standard|critical (SPEC §5).
function tier(v1Tier) {
  return v1Tier === 'critical' ? 'critical' : 'standard';
}

// Converts one v1 feature. The original v1 fields that v2 does not model are kept
// under `v1` for traceability; v1 contracts are referenced, not converted (SPEC §13).
function convert(root, f, index) {
  if (!f || typeof f !== 'object' || typeof f.id !== 'string' || !f.id.trim()) {
    throw new HarnessError(`${V1_FILE}: features[${index}] has no string id — fix the v1 file and retry`, { code: 'v1_invalid' });
  }
  const v1 = { status: f.status ?? null, passes: f.passes === true };
  if (f.security_tier !== undefined) v1.security_tier = f.security_tier;
  if (Array.isArray(f.dependencies) && f.dependencies.length) v1.dependencies = f.dependencies;
  if (f.assigned_sprint !== undefined && f.assigned_sprint !== null) {
    const rel = `${V1_CONTRACTS}/sprint-${f.assigned_sprint}.json`;
    if (fs.existsSync(path.join(root, ...rel.split('/')))) v1.contract = rel;
  }
  const title = [f.name, f.title].find((t) => typeof t === 'string' && t.trim()) ?? f.id; // v1 used either field
  return {
    id: f.id,
    title,
    security_tier: tier(f.security_tier),
    depends_on: [],
    status: isDropped(f.status) ? 'skipped' : f.passes === true ? 'passed' : 'todo',
    v1,
  };
}

// v1 statuses were free text; features taken out of scope must not come back as work.
const isDropped = (status) => typeof status === 'string' && /^\s*(removed|cancelled|canceled|archived)/i.test(status);
const V2_ID = /^F\d+$/;

// v2 ids are F<n>. Other v1 ids get the smallest unused F<n>, in list order; the original id
// stays in v1.id. Dependencies are carried over under the new ids; unknown ones are dropped.
function renumber(features, warn) {
  const used = new Set(features.map((f) => f.id).filter((id) => V2_ID.test(id)));
  const map = new Map();
  let n = 1;
  for (const f of features) {
    if (V2_ID.test(f.id)) { map.set(f.id, f.id); continue; }
    while (used.has(`F${n}`)) n += 1;
    const id = `F${n}`;
    used.add(id);
    map.set(f.id, id);
    f.v1.id = f.id;
    f.id = id;
  }
  for (const f of features) {
    const deps = f.v1.dependencies || [];
    f.depends_on = [...new Set(deps.filter((d) => map.has(d)).map((d) => map.get(d)))].filter((d) => d !== f.id);
    const unknown = deps.filter((d) => !map.has(d));
    if (unknown.length) warn(`${f.id}${f.v1.id ? ` (${f.v1.id})` : ''}: dependencies not in the v1 list were dropped: ${unknown.join(', ')}`);
  }
  return features.filter((f) => f.v1.id).length;
}

// harness migrate-v1 [--force] — progress/feature_list.json → .harness/features.json.
// The v1 location is shown the same way on every OS ('/'), whatever path.join produced.
export function noV1Message(root, pathImpl = path) {
  const shown = pathImpl.join('progress', 'feature_list.json').split(pathImpl.sep).join('/');
  return [`harness: no v1 state found (${shown} does not exist in ${root}).`,
    'migrate-v1 converts a cc-harness v1 project; run it from the root of that project.',
    'For a new project, run `harness init` instead. Nothing was written.'];
}

// Nothing is written unless the whole conversion succeeds.
export default async function migrateV1({ root, args, out, err }) {
  let force = false;
  for (const a of args) {
    if (a === '--force') force = true;
    else throw new HarnessError(`unexpected argument '${a}'. ${USAGE}`, { code: 'usage' });
  }

  const source = path.join(root, V1_FILE);
  if (!fs.existsSync(source)) {
    for (const line of noV1Message(root)) err(line);
    return 2;
  }

  const data = readJson(source); // corrupted JSON → exit 2, file untouched (SPEC E6)
  if (!data || !Array.isArray(data.features)) {
    throw new HarnessError(`${V1_FILE}: expected { "features": [...] } — not a v1 feature list. Nothing was written.`, { code: 'v1_invalid' });
  }
  const features = data.features.map((f, i) => convert(root, f, i));
  const seen = new Set();
  for (const f of features) {
    if (seen.has(f.id)) throw new HarnessError(`${V1_FILE}: duplicate feature id '${f.id}'. Nothing was written.`, { code: 'v1_invalid' });
    seen.add(f.id);
  }

  const warnings = [];
  const renumbered = renumber(features, (m) => warnings.push(m));

  const p = paths(root);
  if (fs.existsSync(p.features) && !force) {
    err(`harness: ${path.relative(root, p.features)} already exists; refusing to overwrite it.`);
    err('Re-run with `harness migrate-v1 --force` to replace it with the converted v1 features. Nothing was written.');
    return 2;
  }

  if (!isInitialized(root)) {
    const code = await init({ root, args: [], out, err });
    if (code !== 0) return code;
  }
  writeJsonAtomic(p.features, { features });

  const count = (st) => features.filter((f) => f.status === st).length;
  out(`migrated ${features.length} feature(s) from ${V1_FILE.split(path.sep).join('/')} to .harness/features.json (${count('passed')} passed, ${count('todo')} todo, ${count('skipped')} skipped)`);
  if (renumbered) out(`${renumbered} feature(s) had v1 ids that are not F<n>; they were renumbered and the old id is kept in v1.id.`);
  for (const w of warnings) err(`warning: ${w}`);
  const withContract = features.filter((f) => f.v1.contract).length;
  if (withContract) out(`${withContract} feature(s) reference a v1 contract under ${V1_CONTRACTS}/ — v1 contracts are not converted; write v2 contracts with the spec skill.`);
  out('v1 files are left in place; remove them when you no longer need them.');
  return 0;
}
