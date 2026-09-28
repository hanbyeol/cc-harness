import fs from 'node:fs';
import path from 'node:path';
import { paths, writeJsonAtomic } from '../state.mjs';
import { detectPreset } from '../testcount.mjs';
import { isLanguage } from '../config.mjs';
import { HarnessError } from '../errors.mjs';

const USAGE = 'usage: harness init [--language <code>]';

// `--language <code>` sets config.language in a new config.json (SPEC §4); checked before
// anything is written.
function languageArg(args = []) {
  const i = args.indexOf('--language');
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new HarnessError(`--language needs a language code such as 'ko' or 'pt-BR'\n${USAGE}`, { code: 'usage' });
  if (!isLanguage(v)) throw new HarnessError(`--language: 'language' must be a language code such as 'ko', 'en' or 'pt-BR', got ${JSON.stringify(v)}`, { code: 'config_invalid' });
  return v;
}

// Creates missing state files; never overwrites existing ones.
export default async function init({ root, args, out }) {
  const p = paths(root);
  const language = languageArg(args);
  // verify.commands is left out so the profile default applies until the user sets it.
  // A test runner detected in the project sets verify.test_count to its preset (§6.2-3).
  const config = { profile: 'sdlc', base_branch: 'main' };
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
  if (!fs.existsSync(ignore)) { fs.writeFileSync(ignore, 'wt/\n*.tmp-*\nruns/test-count-cache.json\n'); created.push(ignore); }

  for (const f of created) out(`created ${path.relative(root, f) || '.'}${f === p.config && preset ? ` (verify.test_count: ${preset})` : ''}`);
  for (const f of kept) out(`kept    ${path.relative(root, f)}`);
  out('next: set verify.commands in .harness/config.json, then run `harness doctor`');
  return 0;
}
