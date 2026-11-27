import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, writeJsonAtomic } from '../state.mjs';
import { detectPreset } from '../testcount.mjs';
import { isLanguage, loadConfig } from '../config.mjs';
import { updateClaudeMd } from '../claudemd.mjs';
import { HarnessError } from '../errors.mjs';
import { usageLine } from '../help.mjs';
import { DEPLOYMENTS_FILE } from './deploy-log.mjs';

const RUNNER = 'test/t.mjs';
const RUNNER_SOURCE = fileURLToPath(new URL('../../test/t.mjs', import.meta.url));
const HINTS = {
  'preset:go': 'go test -run F3AC1',
  'preset:pytest': 'pytest -k F3_AC_1',
};

// node --test projects get the criterion check runner (SPEC §4); it is never overwritten, and
// a symbolic link (even a dangling one) at the path counts as present, so nothing is written
// through it. Returns the line to print, or null after a warning.
function installRunner(root, warn) {
  const dest = path.join(root, 'test', 't.mjs');
  if (fs.existsSync(path.join(root, 'test')) && !fs.statSync(path.join(root, 'test')).isDirectory()) {
    warn(`${RUNNER} not created: 'test' is not a directory`);
    return null;
  }
  try { fs.lstatSync(dest); return `kept    ${RUNNER}`; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.writeFileSync(dest, fs.readFileSync(RUNNER_SOURCE), { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') return `kept    ${RUNNER}`;
    throw e;
  }
  return `created ${RUNNER}`;
}

const USAGE = usageLine('init');

// `--language <code>` sets config.language in a new config.json (SPEC §4); checked before
// anything is written.
function languageArg(args = []) {
  const stray = args.find((a, i) => a !== '--language' && args[i - 1] !== '--language');
  if (stray !== undefined) throw new HarnessError(`unexpected argument '${stray}'\n${USAGE}`, { code: 'usage' });
  const i = args.indexOf('--language');
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new HarnessError(`--language needs a language code such as 'ko' or 'pt-BR'\n${USAGE}`, { code: 'usage' });
  if (!isLanguage(v)) throw new HarnessError(`--language: 'language' must be a language code such as 'ko', 'en' or 'pt-BR', got ${JSON.stringify(v)}`, { code: 'config_invalid' });
  return v;
}

// Creates missing state files; never overwrites existing ones.
export default async function init({ root, args, out, err = console.error }) {
  const p = paths(root);
  const language = languageArg(args);
  // verify.commands is left out so the profile default applies until the user sets it.
  // A test runner detected in the project sets verify.test_count to its preset (§6.2-3).
  // A new project approves contracts itself once lint passes (approval 'auto', SPEC §4).
  const config = { profile: 'sdlc', base_branch: 'main', approval: 'auto' };
  if (language) config.language = language;
  const preset = detectPreset(root);
  if (preset) config.verify = { test_count: preset };
  const files = [
    [p.config, config],
    [p.features, { features: [] }],
    [p.backlog, { items: [] }],
  ];
  const created = [];
  const kept = [];
  for (const dir of [p.dir, p.contracts, p.verdicts, p.runs]) {
    if (fs.existsSync(dir)) kept.push(dir);
    else { fs.mkdirSync(dir, { recursive: true }); created.push(dir); }
  }
  for (const [file, data] of files) {
    if (fs.existsSync(file)) kept.push(file);
    else { writeJsonAtomic(file, data); created.push(file); }
  }
  const ignore = path.join(p.dir, '.gitignore');
  if (!fs.existsSync(ignore)) { fs.writeFileSync(ignore, 'wt/\n*.tmp-*\nruns/test-count-cache.json\nruns/verify-cache.json\n'); created.push(ignore); }
  // Append-only JSON Lines records merge line by line, so two branches that each add a line
  // do not conflict (SPEC §4). JSON state files are left to git's default merge.
  const attrs = path.join(p.dir, '.gitattributes');
  let st = null;
  try { st = fs.lstatSync(attrs); } catch { /* missing */ }
  if (st && st.isDirectory()) err(`harness: warning: ${path.relative(root, attrs)} not created: it is a directory`);
  else if (st) kept.push(attrs);
  else {
    try {
      fs.writeFileSync(attrs, `runs/*.jsonl merge=union\n${DEPLOYMENTS_FILE} merge=union\n`, { flag: 'wx' });
      created.push(attrs);
    } catch (e) { err(`harness: warning: ${path.relative(root, attrs)} not created: ${e.message}`); }
  }

  // Printed with forward slashes on every platform ('created .harness/.gitattributes').
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');
  for (const f of created) out(`created ${rel(f) || '.'}${f === p.config && preset ? ` (verify.test_count: ${preset})` : ''}`);
  for (const f of kept) out(`kept    ${rel(f)}`);
  if (preset === 'preset:node-test') {
    const line = installRunner(root, (m) => err(`harness: warning: ${m}`));
    if (line) out(line);
  }
  // The CLAUDE.md block (SPEC §4.1) in the language of the config just written or kept.
  // A CLAUDE.md the block cannot be written into is reported; the state files stay created.
  try {
    const { language, profile } = loadConfig(root);
    const { action } = updateClaudeMd(root, { language, profile, warn: (m) => err(`harness: warning: ${m}`) });
    out(`${{ created: 'created', inserted: 'updated', updated: 'updated', unchanged: 'kept   ' }[action]} CLAUDE.md${action === 'unchanged' ? '' : ' (cc-harness block)'}`);
  } catch (e) {
    if (!(e instanceof HarnessError)) throw e;
    err(`harness: warning: CLAUDE.md not changed: ${e.message}`);
  }
  if (preset !== 'preset:node-test') {
    out(`hint: name the test each criterion's check runs after its id so one test can be run, e.g. ${HINTS[preset] ?? '<your test runner> "F3 AC-1"'}`);
  }
  out('next: set verify.commands in .harness/config.json, then run `harness doctor`');
  return 0;
}
