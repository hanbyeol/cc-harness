// Stand-in for an installed `claude` on PATH that records the model it was called with:
// `node fake-model-cli.mjs ...args`.
//   --version   print a version line
//   --help      print the measured claude help fixture
//   otherwise   append {argv, cwd, head, conflict} (head = first 400 characters of the prompt,
//               conflict = the prompt asks for a merge conflict resolution) as one
//               JSON line to $FAKE_MODEL_LOG, then act as the role:
//               plan mode (evaluator roles) → a claude wrapper with a passing evaluation;
//               write mode (builder) → writes <feature>.txt and shared.txt ("<feature>\n")
//               in cwd, or on a merge conflict resolution "resolved\n" to each listed file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const HELP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'help', 'claude-2.1.280.txt');

const wrapper = (result, structured) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, result,
  ...(structured ? { structured_output: structured } : {}),
});

if (args[0] === '--version') {
  process.stdout.write('2.1.280 (Claude Code)\n');
} else if (args[0] === '--help') {
  process.stdout.write(fs.readFileSync(HELP, 'utf8'));
} else {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  if (process.env.FAKE_MODEL_LOG) {
    fs.appendFileSync(process.env.FAKE_MODEL_LOG, JSON.stringify({ argv: args, cwd: process.cwd(), head: stdin.slice(0, 400), conflict: stdin.includes('# Merge conflict resolution') }) + '\n');
  }
  const mode = args[args.indexOf('--permission-mode') + 1];
  if (mode === 'plan') {
    const reply = { scores: { functionality: 9, quality: 9, security: 9, errors: 9, tests: 9 }, findings: [], out_of_scope: [] };
    process.stdout.write(wrapper(JSON.stringify(reply), reply));
  } else {
    const id = /# Task: feature (F\d+)/.exec(stdin)?.[1] ?? 'F0';
    const at = stdin.indexOf('# Merge conflict resolution');
    if (at !== -1) {
      for (const m of stdin.slice(at).matchAll(/^- (.+)$/gm)) fs.writeFileSync(path.join(process.cwd(), m[1]), 'resolved\n');
    } else {
      fs.writeFileSync(path.join(process.cwd(), `${id}.txt`), 'built\n');
      fs.writeFileSync(path.join(process.cwd(), 'shared.txt'), `${id}\n`);
    }
    process.stdout.write(wrapper('done'));
  }
}
