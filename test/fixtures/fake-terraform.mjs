// A fake `terraform` for test/f40-tf-check.test.mjs (see the comment there).
import fs from 'node:fs';
import path from 'node:path';
const [sub, ...rest] = process.argv.slice(2);
const cache = process.env.TF_PLUGIN_CACHE_DIR || null;
fs.appendFileSync(process.env.FAKE_TF_LOG, JSON.stringify({ sub, args: rest, cwd: fs.realpathSync(process.cwd()), cache }) + '\n');
const tfs = (dir, deep) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.tf')) out.push(fs.readFileSync(path.join(dir, e.name), 'utf8'));
    else if (deep && e.isDirectory() && !e.name.startsWith('.')) out.push(tfs(path.join(dir, e.name), true));
  }
  return out.join('\n');
};
const has = (text, marker) => text.includes(marker);
if (sub === 'init') {
  const text = tfs('.', false);
  if (has(text, 'FAIL_INIT')) { process.stderr.write('Error: Failed to query available provider packages ' + 'x'.repeat(400) + '\n'); process.exit(1); }
  if (cache) {
    const provider = path.join(cache, 'fake-provider');
    if (!fs.existsSync(provider)) {
      fs.writeFileSync(provider, 'binary');
      fs.appendFileSync(process.env.FAKE_TF_LOG, JSON.stringify({ sub: 'download' }) + '\n');
    }
  }
} else if (sub === 'validate') {
  if (has(tfs('.', false), 'FAIL_VALIDATE')) { process.stderr.write('Error: Unsupported argument\n'); process.exit(1); }
} else if (sub === 'fmt') {
  if (has(tfs('.', true), 'FAIL_FMT')) { process.stdout.write('main.tf\n'); process.exit(3); }
}
