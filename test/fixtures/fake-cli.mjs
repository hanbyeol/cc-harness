// Stand-in for a model CLI in adapter tests: `node fake-cli.mjs <mode> [arg] ...adapterArgs`.
//   echo-args      print {"argv":[...adapterArgs],"stdin":"..."} as JSON
//   print <file>   print the file's contents (e.g. a recorded claude wrapper)
//   print-fail <file>  same, then exit 1 (the recorded run exited 1)
//   text <string>  print the string
//   exit <code>    write to stderr and exit with <code>
//   exit-unread <code>  exit with <code> immediately, never reading stdin
//   sleep <pidfile> write own pid to <pidfile> and sleep 60s
import fs from 'node:fs';

const [mode, arg, ...rest] = process.argv.slice(2);

async function readStdin() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

if (mode === 'echo-args') {
  const stdin = await readStdin();
  process.stdout.write(JSON.stringify({ argv: [arg, ...rest].filter((x) => x !== undefined), stdin }));
} else if (mode === 'print') {
  await readStdin();
  process.stdout.write(fs.readFileSync(arg, 'utf8'));
} else if (mode === 'print-fail') {
  await readStdin();
  process.stdout.write(fs.readFileSync(arg, 'utf8'));
  process.exit(1);
} else if (mode === 'text') {
  await readStdin();
  process.stdout.write(arg);
} else if (mode === 'exit') {
  await readStdin();
  process.stderr.write('fake failure\n');
  process.exit(Number(arg));
} else if (mode === 'exit-unread') {
  // exits without touching stdin, so a large prompt write hits a closed pipe (EPIPE)
  process.exit(Number(arg));
} else if (mode === 'sleep') {
  fs.writeFileSync(arg, String(process.pid));
  setTimeout(() => {}, 60_000);
}
