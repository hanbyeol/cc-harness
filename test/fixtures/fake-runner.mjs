// Stand-in for a test runner on PATH: `node fake-runner.mjs <go|python> ...args`.
// Records its arguments to `<name>-args.json` in the working directory, then prints
// `fake-<name>.out` from the working directory (the test decides the output) and exits
// with the code in `fake-<name>.code` (default 0).
import fs from 'node:fs';

const [name, ...args] = process.argv.slice(2);
fs.writeFileSync(`${name}-args.json`, JSON.stringify(args));
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
process.stdout.write(read(`fake-${name}.out`) ?? '');
process.exitCode = Number((read(`fake-${name}.code`) ?? '0').trim());
