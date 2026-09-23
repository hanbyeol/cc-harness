import fs from 'node:fs';
import path from 'node:path';
import { paths, writeJsonAtomic } from '../state.mjs';

// Creates missing state files; never overwrites existing ones.
export default async function init({ root, out }) {
  const p = paths(root);
  const files = [
    // verify.commands is left out so the profile default applies until the user sets it.
    [p.config, { profile: 'sdlc', base_branch: 'main' }],
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
  if (!fs.existsSync(ignore)) { fs.writeFileSync(ignore, 'wt/\n*.tmp-*\n'); created.push(ignore); }

  for (const f of created) out(`created ${path.relative(root, f) || '.'}`);
  for (const f of kept) out(`kept    ${path.relative(root, f)}`);
  out('next: set verify.commands in .harness/config.json, then run `harness doctor`');
  return 0;
}
