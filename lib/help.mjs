// Per-command usage text for `harness <command> --help`. Pure data: no state is read.
// The first line of each entry starts with `usage: harness <name>`; the option names are
// the ones the command parses.
export const USAGE = {
  init: ['[--language <code>]', ['--language <code>  set config.language in a new config.json (ko, en, pt-BR, ...)']],
  'lint-contract': ['[F<n> ...]', []],
  approve: ['F<n> [--by <name>] [--extra-round]', [
    '--by <name>     who approved (default: the git user)',
    '--extra-round   allow one more round after the rounds are used up']],
  verify: ['F<n> [--base <ref>] [--cwd <dir>] [--json]', [
    '--base <ref>   compare against this base ref',
    '--cwd <dir>    verify the tree in this directory',
    '--json         print the result as JSON']],
  eval: ['F<n> [--round <k>] [--base <ref>] [--cwd <dir>] [--json]', [
    '--round <k>    evaluation round number',
    '--base <ref>   compare against this base ref',
    '--cwd <dir>    evaluate the tree in this directory',
    '--json         print the result as JSON']],
  run: ['[F<n> ...] [--resume] [--fresh] [--max-usd <n>] [--parallel <n>]', [
    '--resume        continue an interrupted run from its state file',
    '--fresh         discard an interrupted run and start over',
    '--max-usd <n>   stop when the cost reaches this many dollars',
    '--parallel <n>  run at most n features at once (1 = sequential)']],
  status: ['[--brief] [--todo-v1]', [
    '--brief     one summary line (used by the SessionStart hook)',
    '--todo-v1   list the todo features that came from v1']],
  stats: ['[--since <YYYY-MM-DD>] [--json]', [
    '--since <date>  only steps from this date on',
    '--json          print the result as JSON']],
  events: ['[--stage <stage>] [--feature F<n>] [--since <date>] [--json]', [
    '--stage <stage>   only this stage',
    '--feature F<n>    only this feature',
    '--since <date>    only events from this date on',
    '--json            print events as JSON lines']],
  decide: ['F<n> --accept-risk|--split|--rewrite "<reason>"', [
    '--accept-risk   keep the feature as is and record the accepted risk',
    '--split         split the feature into smaller ones',
    '--rewrite       rewrite the contract']],
  backlog: ['close B<n> [B<m> ...] --resolved|--obsolete [--] "<reason>"', [
    '--resolved   the item is solved',
    '--obsolete   the item needs no work',
    '--           everything after it is the reason, even if it starts with -']],
  doctor: ['', []],
  'claude-md': ['[--check]', ['--check   report whether the block is current; write nothing']],
  'tf-check': ['[--dir <path>]', ['--dir <path>   check this module directory']],
  'migrate-v1': ['[--force]', ['--force   convert even if .harness/features.json exists']],
};

export function commandHelp(name, summary) {
  const [synopsis, options] = USAGE[name];
  const lines = [`usage: harness ${name}${synopsis ? ` ${synopsis}` : ''}`, '', summary];
  if (options.length) lines.push('', 'options:', ...options.map((o) => `  ${o}`));
  return lines.join('\n');
}

// The usage line of a command, for errors.
export function usageLine(name) {
  const [synopsis] = USAGE[name];
  return `usage: harness ${name}${synopsis ? ` ${synopsis}` : ''}`;
}
