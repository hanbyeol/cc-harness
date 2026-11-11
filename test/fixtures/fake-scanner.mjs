// A fake policy scanner (tflint, trivy, checkov) for test/f160-tf-check-test-scan.test.mjs.
// argv[2] is the scanner's name (put there by the fakeNodeCli wrapper). The call is appended to
// $FAKE_TF_LOG as { scanner, args, cwd }. $FAKE_SCAN_EXIT_<NAME> sets the exit code (default 0);
// a non-zero exit prints findings ending in SCAN_TAIL_<name> to stdout.
import fs from 'node:fs';
const [name, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_TF_LOG, JSON.stringify({ scanner: name, args, cwd: fs.realpathSync.native(process.cwd()) }) + '\n');
const code = Number(process.env[`FAKE_SCAN_EXIT_${name.toUpperCase()}`] || 0);
if (code !== 0) process.stdout.write(`${'finding '.repeat(500)}\nSCAN_TAIL_${name}\n`);
process.exit(code);
