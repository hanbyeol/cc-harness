// Stand-in for an installed `claude` builder on PATH (F108): `node fake-claude-builder.mjs ...args`.
//   --version   print a version line
//   --help      print the measured claude help fixture
//   otherwise   read the prompt from stdin, then:
//     - save it as <FAKE_CLAUDE_PROMPTS>/<token>.txt when FAKE_CLAUDE_PROMPTS is set
//     - append 'start <token> <maxParallel>' to FAKE_CLAUDE_LOG when it is set (maxParallel is
//       read from the run state file FAKE_CLAUDE_STATE, or '-'), wait FAKE_CLAUDE_HOLD_MS
//       (default 0) and append 'end <token>'
//     - in the working directory write <feature>.txt; a merge conflict resolution writes
//       shared.txt 'both', a post-merge recovery writes fixed.txt, any other build changes an
//       existing shared.txt to 'feature'
//     - print a normal end_turn result wrapper and exit 0
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write('2.1.280 (Claude Code, fake)\n');
} else if (args[0] === '--help') {
  process.stdout.write(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'help', 'claude-2.1.280.txt'), 'utf8'));
} else {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const token = randomBytes(8).toString('hex');
  const env = process.env;
  if (env.FAKE_CLAUDE_PROMPTS) fs.writeFileSync(path.join(env.FAKE_CLAUDE_PROMPTS, `${token}.txt`), prompt);
  if (env.FAKE_CLAUDE_LOG) {
    let max = '-';
    try { max = String(JSON.parse(fs.readFileSync(env.FAKE_CLAUDE_STATE, 'utf8')).maxParallel); } catch { /* no state */ }
    fs.appendFileSync(env.FAKE_CLAUDE_LOG, `start ${token} ${max}\n`);
    await new Promise((r) => setTimeout(r, Number(env.FAKE_CLAUDE_HOLD_MS || 0)));
    fs.appendFileSync(env.FAKE_CLAUDE_LOG, `end ${token}\n`);
  }
  const id = /# Task: feature (F\d+),/.exec(prompt)?.[1] ?? 'unknown';
  fs.writeFileSync(`${id}.txt`, 'built\n');
  if (prompt.includes('# Merge conflict resolution')) fs.writeFileSync('shared.txt', 'both\n');
  else if (prompt.includes('# Post-merge verification failure')) fs.writeFileSync('fixed.txt', 'fixed\n');
  else if (fs.existsSync('shared.txt')) fs.writeFileSync('shared.txt', 'feature\n');
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', safety_stops: 0,
    result: 'done', total_cost_usd: 0, num_turns: 1, session_id: `00000000-0000-4000-8000-${token.slice(0, 12)}`,
  }));
}
