// Stand-in for an installed `claude` on PATH: `node fake-claude.mjs ...args`.
//   --version   print a version line
//   --help      print the measured claude help fixture
//   otherwise   read stdin, print the file named by FAKE_CLAUDE_REPLY and exit with
//               FAKE_CLAUDE_EXIT (default 0)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write('2.1.280 (Claude Code, fake)\n');
} else if (args[0] === '--help') {
  process.stdout.write(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'help', 'claude-2.1.280.txt'), 'utf8'));
} else {
  for await (const _ of process.stdin) { /* drain */ }
  process.stdout.write(fs.readFileSync(process.env.FAKE_CLAUDE_REPLY, 'utf8'));
  process.exit(Number(process.env.FAKE_CLAUDE_EXIT || 0));
}
