#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HarnessError } from '../lib/errors.mjs';
import { isInitialized, loadFeatures, paths } from '../lib/state.mjs';
import { loadConfig } from '../lib/config.mjs';
import { commandHelp } from '../lib/help.mjs';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'commands');

// name → [summary, needs initialized state]
const COMMANDS = {
  init: ['create .harness/ state in the current project', false],
  'lint-contract': ['check contracts are decidable and within limits', true],
  approve: ['record plan approval and freeze contracts by hash', true],
  verify: ['run deterministic verification for a feature', true],
  eval: ['run the independent evaluator for a feature', true],
  run: ['autonomously build, verify and evaluate approved features', true],
  status: ['show feature status and what can run next', false],
  stats: ['aggregate step metrics and suggest config changes', true],
  events: ['show the event log (.harness/events) oldest first', true],
  decide: ['record a human decision on a feature (--accept-risk|--split|--rewrite|--drop)', true],
  backlog: ['close open backlog items (close B<n>... --resolved|--obsolete "<reason>")', true],
  doctor: ['detect installed CLIs and check adapter flags', false],
  'claude-md': ['write the cc-harness block into CLAUDE.md (--check: report only)', false],
  'tf-check': ['terraform init/validate per module directory and fmt (iac profile verify)', false],
  'migrate-v1': ['convert cc-harness v1 progress/ state into .harness/', false],
};

function help() {
  const lines = ['usage: harness <command> [options]', '', 'commands:'];
  for (const [name, [summary]] of Object.entries(COMMANDS)) lines.push(`  ${name.padEnd(14)} ${summary}`);
  lines.push('', 'harness <command> --help   options of one command');
  return lines.join('\n');
}

export async function main(argv, { root = process.cwd(), out = console.log, err = console.error } = {}) {
  const [name, ...args] = argv;
  const known = (n) => Object.hasOwn(COMMANDS, n);
  const unknown = (n) => new HarnessError(`unknown command '${n}'. Run \`harness --help\`.`, { code: 'usage' });
  // Help is answered before any state file is read (SPEC §3): arguments after `--` are values.
  const dash = args.indexOf('--');
  const wantsHelp = (dash === -1 ? args : args.slice(0, dash)).some((a) => a === '--help' || a === '-h');
  if (!name || name === '--help' || name === '-h' || (name === 'help' && !args.length)) {
    out(help());
    return 0;
  }
  try {
    if (name === 'help' || wantsHelp) {
      const target = name === 'help' ? args[0] : name;
      if (!known(target)) throw unknown(target);
      out(commandHelp(target, COMMANDS[target][0]));
      return 0;
    }
    const spec = known(name) ? COMMANDS[name] : undefined;
    if (!spec) throw unknown(name);
    // Every command refuses to run on corrupted state (SPEC E6), including init.
    // init may complete a partial .harness/ (e.g. only contracts/), so a file that
    // is missing is not an error for it — one that exists is still checked.
    if (isInitialized(root)) {
      const p = paths(root);
      if (name !== 'init' || fs.existsSync(p.config)) loadConfig(root);
      if (name !== 'init' || fs.existsSync(p.features)) loadFeatures(root);
    }
    else if (spec[1]) throw new HarnessError('not initialized — run `harness init`', { code: 'not_initialized' });

    let mod;
    try {
      mod = await import(pathToFileURL(path.join(LIB, `${name}.mjs`)).href);
    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND' && e.message.includes(`${name}.mjs`)) {
        throw new HarnessError(`'${name}' is not implemented yet`, { code: 'not_implemented' });
      }
      throw e;
    }
    return await mod.default({ root, args, out, err });
  } catch (e) {
    if (e instanceof HarnessError) {
      err(`harness: ${e.message}`);
      return e.exit;
    }
    err(`harness: internal error: ${e.message}`);
    if (process.env.HARNESS_DEBUG) err(e.stack);
    return 1;
  }
}

// Run as a CLI unless imported (tests import `main`). realpath: npm bin shims are symlinks.
const self = fs.realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === self) {
  process.exitCode = await main(process.argv.slice(2));
}
