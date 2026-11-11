// `harness deploy-log record|list` — the result of a live terraform apply (plan-review skill) or
// kubectl/helm rollout (rollout skill), attached to a feature in the git-tracked
// .harness/deployments.jsonl (SPEC §4). Recording never changes a feature's status.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HarnessError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { paths, loadFeatures } from '../state.mjs';
import { redactor } from '../failures.mjs';
import { usageLine } from '../help.mjs';

export const DEPLOYMENTS_FILE = 'deployments.jsonl';
export const NOTE_MAX = 500;
const KINDS = Object.freeze({ apply: 'apply', rollout: 'rollout' });
const RESULTS = Object.freeze({ ok: 'ok', failed: 'failed', 'rolled-back': 'rolled_back' });
const FEATURE_ID = /^F\d+$/;

const usage = (message) => new HarnessError(`${message}\n${usageLine('deploy-log')}`, { code: 'usage' });
const logFile = (root) => path.join(paths(root).dir, DEPLOYMENTS_FILE);

// The feature id comes first; flags in any order; the note (one argument) is the remaining
// positional. Every argument after `--` is a note, so a note may start with '-'.
function parseRecord(args) {
  const end = args.indexOf('--');
  const head = end === -1 ? args : args.slice(0, end);
  const notes = end === -1 ? [] : args.slice(end + 1);
  const positional = [];
  let kind = null;
  let result = null;
  let target = null;
  for (let i = 0; i < head.length; i++) {
    const a = head[i];
    const flag = a.startsWith('--') ? a.slice(2) : null;
    if (flag !== null && Object.hasOwn(KINDS, flag)) {
      if (kind) throw usage(`give one of --apply|--rollout, not --${kind} and ${a}`);
      kind = KINDS[flag];
    } else if (flag !== null && Object.hasOwn(RESULTS, flag)) {
      if (result) throw usage(`give one of --ok|--failed|--rolled-back, not two (${a})`);
      result = RESULTS[flag];
    } else if (a === '--target') {
      if (target !== null) throw usage('give --target once');
      if (i + 1 >= head.length) throw usage('--target needs a value');
      target = head[++i];
    } else if (a.startsWith('-') && a.length > 1) throw usage(`unexpected option '${a}'`);
    else positional.push(a);
  }
  const [id, ...rest] = positional;
  if (id === undefined) throw usage('deploy-log record needs a feature id F<n>');
  if (!FEATURE_ID.test(id)) throw usage(`not a feature id: ${id} (expected F<n>)`);
  if (!kind) throw usage('deploy-log record needs one of --apply|--rollout');
  if (!result) throw usage('deploy-log record needs one of --ok|--failed|--rolled-back');
  if (target === null || !target.trim()) throw usage('deploy-log record needs a non-empty --target <name>');
  notes.unshift(...rest);
  if (notes.length > 1) throw usage('give the note as one quoted argument');
  const note = (notes[0] ?? '').trim();
  if (!note) throw usage('deploy-log record needs a non-empty note');
  return { id, kind, result, target: target.trim(), note };
}

function gitOut(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const v = r.status === 0 ? r.stdout.trim() : '';
  return v || null;
}

function record(root, args, out, err) {
  const { id, kind, result, target, note } = parseRecord(args);
  const feature = loadFeatures(root).features.find((f) => f.id === id);
  if (!feature) throw new HarnessError(`unknown feature ${id} — not in .harness/features.json`, { code: 'usage' });
  const redact = redactor(process.env, loadConfig(root).env_allowlist);
  const entry = {
    feature: id,
    kind,
    result,
    target: redact(target),
    note: redact(note).slice(0, NOTE_MAX),
    at: new Date().toISOString(),
    by: gitOut(root, ['config', 'user.name']),
    commit: gitOut(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
  };
  const file = logFile(root);
  let prefix = '';
  try {
    const st = fs.statSync(file);
    if (st.size > 0) {
      const fd = fs.openSync(file, 'r');
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, st.size - 1);
        if (last[0] !== 0x0a) prefix = '\n'; // keep the existing last line intact
      } finally { fs.closeSync(fd); }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw new HarnessError(`${file}: cannot read (${e.code})`, { code: 'io' });
  }
  try {
    fs.appendFileSync(file, `${prefix}${JSON.stringify(entry)}\n`);
  } catch (e) {
    throw new HarnessError(`${file}: write failed (${e.code || e.message})`, { code: 'io' });
  }
  if (feature.status !== 'passed') err(`harness: warning: ${id} is ${feature.status}, not passed`);
  out(`recorded ${kind} ${result} for ${id} (${entry.target})`);
  return 0;
}

function parseList(args) {
  let json = false;
  let id = null;
  for (const a of args) {
    if (a === '--json') json = true;
    else if (a.startsWith('-')) throw usage(`unexpected option '${a}'`);
    else if (id !== null) throw usage('deploy-log list takes at most one feature id');
    else if (!FEATURE_ID.test(a)) throw usage(`not a feature id: ${a} (expected F<n>)`);
    else id = a;
  }
  return { id, json };
}

function list(root, args, out, err) {
  const { id, json } = parseList(args);
  let text = '';
  const file = logFile(root);
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') throw new HarnessError(`${file}: cannot read (${e.code})`, { code: 'io' });
  }
  const rows = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let rec;
    try { rec = JSON.parse(line); } catch { rec = undefined; }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      err(`harness: warning: ${DEPLOYMENTS_FILE} line ${i + 1} is not JSON`);
      return;
    }
    if (id === null || rec.feature === id) rows.push(rec);
  });
  if (!rows.length) out('no deployments');
  for (const r of rows) {
    out(json ? JSON.stringify(r) : `${r.at} ${r.feature} ${r.kind} ${r.result} ${r.target} — ${r.note}`);
  }
  return 0;
}

export default async function deployLog({ root, args, out, err }) {
  const [sub, ...rest] = args;
  if (sub === 'record') return record(root, rest, out, err);
  if (sub === 'list') return list(root, rest, out, err);
  throw usage(sub === undefined ? 'deploy-log needs a subcommand (record|list)' : `unknown deploy-log subcommand '${sub}'`);
}
