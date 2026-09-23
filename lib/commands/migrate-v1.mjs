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
  return {
    id: f.id,
    title: typeof f.name === 'string' && f.name ? f.name : f.id,
    security_tier: tier(f.security_tier),
    depends_on: [],
    status: f.passes === true ? 'passed' : 'todo',
    v1,
  };
}

// harness migrate-v1 [--force] — progress/feature_list.json → .harness/features.json.
// Nothing is written unless the whole conversion succeeds.
export default async function migrateV1({ root, args, out, err }) {
  let force = false;
  for (const a of args) {
    if (a === '--force') force = true;
    else throw new HarnessError(`unexpected argument '${a}'. ${USAGE}`, { code: 'usage' });
  }

  const source = path.join(root, V1_FILE);
  if (!fs.existsSync(source)) {
    err(`harness: no v1 state found (${V1_FILE} does not exist in ${root}).`);
    err('migrate-v1 converts a cc-harness v1 project; run it from the root of that project.');
    err('For a new project, run `harness init` instead. Nothing was written.');
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

  const passed = features.filter((f) => f.status === 'passed').length;
  out(`migrated ${features.length} feature(s) from ${V1_FILE.split(path.sep).join('/')} to .harness/features.json (${passed} passed, ${features.length - passed} todo)`);
  const withContract = features.filter((f) => f.v1.contract).length;
  if (withContract) out(`${withContract} feature(s) reference a v1 contract under ${V1_CONTRACTS}/ — v1 contracts are not converted; write v2 contracts with the spec skill.`);
  out('v1 files are left in place; remove them when you no longer need them.');
  return 0;
}
