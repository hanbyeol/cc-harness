#!/usr/bin/env node
// A fake GitHub CLI for the F186 tests. Its per-test data lives in <cwd>/.git/fake-gh/ (the core
// runs gh in the project root and passes it only an allowlisted environment):
// - calls.log       one JSON array of arguments per call, appended
// - responses.json  { "<key>": response | [response, ...] }; a list is answered in order and its
//                   last entry repeats. Keys: "list" (gh run list --commit), "branch" (gh run
//                   list --branch), "view:<id>" (gh run view <id>).
// A response is { json?, stdout?, stderr?, code?, sleep_ms?, done_file? }: after sleeping
// sleep_ms it writes done_file (when given), then prints json (as JSON) or stdout.
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), '.git', 'fake-gh');
const args = process.argv.slice(2);
fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(path.join(dir, 'calls.log'), `${JSON.stringify(args)}\n`);

let responses = {};
try { responses = JSON.parse(fs.readFileSync(path.join(dir, 'responses.json'), 'utf8')); } catch { /* none */ }

let key = args.join(' ');
if (args[0] === 'run' && args[1] === 'list') key = args.includes('--branch') ? 'branch' : 'list';
else if (args[0] === 'run' && args[1] === 'view') key = `view:${args[2]}`;

let r = responses[key];
if (Array.isArray(r)) {
  const counter = path.join(dir, `${key.replace(/[^A-Za-z0-9]/g, '_')}.count`);
  let n = 0;
  try { n = Number(fs.readFileSync(counter, 'utf8')) || 0; } catch { /* first call */ }
  fs.writeFileSync(counter, String(n + 1));
  r = r[Math.min(n, r.length - 1)];
}
if (!r) {
  process.stderr.write(`fake gh: no response for '${key}'\n`);
  process.exit(9);
}
if (r.sleep_ms) await new Promise((resolve) => setTimeout(resolve, r.sleep_ms));
if (r.done_file) fs.writeFileSync(path.join(dir, r.done_file), 'done');
if (r.json !== undefined) process.stdout.write(JSON.stringify(r.json));
else if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exitCode = r.code ?? 0;
