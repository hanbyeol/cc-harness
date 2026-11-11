// A fake `kubeconform`, `kustomize` and `helm` for test/f161-k8s-check.test.mjs (see the comment
// there). The first argument is the tool name (fakeNodeCli passes it before the real arguments).
import fs from 'node:fs';
import path from 'node:path';

const [tool, ...args] = process.argv.slice(2);
const readStdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };
// Every YAML file under dir (recursive, sorted), concatenated: what a renderer would emit.
const yamlUnder = (dir) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(yamlUnder(f));
    else if (/\.ya?ml$/.test(e.name) || e.name === 'Kustomization') out.push(fs.readFileSync(f, 'utf8'));
  }
  return out.join('\n---\n');
};

const entry = { tool, args, cwd: fs.realpathSync.native(process.cwd()) };
if (tool === 'kubeconform') {
  const files = args.filter((a) => a === '-' || !a.startsWith('-'));
  let text = '';
  for (const f of files) {
    if (f === '-') { entry.stdin = readStdin(); text += entry.stdin; }
    else text += fs.readFileSync(f, 'utf8');
  }
  fs.appendFileSync(process.env.FAKE_K8S_LOG, JSON.stringify(entry) + '\n');
  if (text.includes('FAIL_KUBECONFORM')) {
    process.stdout.write('stdin - Deployment web is invalid: problem validating schema\nSummary: 1 resource found - Valid: 0, Invalid: 1\n');
    process.exit(1);
  }
  process.stdout.write('Summary: 1 resource found - Valid: 1, Invalid: 0\n');
} else {
  fs.appendFileSync(process.env.FAKE_K8S_LOG, JSON.stringify(entry) + '\n');
  // kustomize build <dir> | helm template <dir>
  const dir = args[1];
  const text = yamlUnder(dir);
  if (text.includes('FAIL_RENDER')) {
    process.stderr.write(`Error: ${tool} cannot render ${dir}: accumulating resources\n`);
    process.exit(1);
  }
  process.stdout.write(`# rendered by ${tool}\n${text}\n`);
}
