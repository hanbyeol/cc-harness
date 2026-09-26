// Stand-in for an installed model CLI on PATH: `node fake-role-cli.mjs <claude|gemini> ...args`.
//   --version   print a version line
//   --help      print the measured help fixture of that CLI
//   otherwise   read stdin, write the GEMINI_API_KEY value to stderr and exit 41
//               (gemini's authentication failure code; the key is echoed so a test can
//               prove the harness never repeats adapter stderr containing it)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = { claude: 'claude-2.1.280.txt', gemini: 'gemini-0.38.1.txt' };
const [name, ...args] = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write(`${name} 0.0.0-fake\n`);
} else if (args[0] === '--help') {
  process.stdout.write(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'help', HELP[name]), 'utf8'));
} else {
  for await (const _ of process.stdin) { /* drain */ }
  process.stderr.write(`auth failed for key ${process.env.GEMINI_API_KEY ?? ''}\n`);
  process.exit(41);
}
