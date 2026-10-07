import { HarnessError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { contractIds, lintContract, loadContract } from '../contract.mjs';
import { paths } from '../state.mjs';
import { readBacklog } from '../backlog.mjs';
import { recordEvent } from '../events.mjs';

export function formatProblem(id, p) {
  return `${id}${p.id ? ` ${p.id}` : ''}: ${p.level}: ${p.message}`;
}

// plan/lint event data: rule name and criterion id of each error and warning, and their counts.
export function lintEventData(contract, problems) {
  const of = (level) => problems.filter((p) => p.level === level).map((p) => ({ rule: p.rule ?? null, id: p.id ?? null }));
  const errors = of('error');
  const warnings = of('warning');
  return { version: contract?.version ?? null, errors, warnings, error_count: errors.length, warning_count: warnings.length };
}

// harness lint-contract [F1 F2 ...] — exit 0 clean, 1 lint errors, 2 usage/parse errors.
export default async function lintContractCmd({ root, args, out, err }) {
  const flags = args.filter((a) => a.startsWith('-'));
  if (flags.length) throw new HarnessError(`unknown option '${flags[0]}'. usage: harness lint-contract [F1 F2 ...]`, { code: 'usage' });
  const ids = args.length ? args : contractIds(root);
  if (!ids.length) { out('no contracts found'); return 0; }
  const config = loadConfig(root);
  const { limits } = config;
  const backlog = readBacklog(paths(root).backlog).items;

  let errors = 0;
  let warnings = 0;
  let broken = 0;
  // Keep going after a bad file so one run reports every problem.
  for (const id of ids) {
    let loaded;
    try {
      loaded = loadContract(root, id);
    } catch (e) {
      if (!(e instanceof HarnessError)) throw e;
      err(`harness: ${e.message}`);
      broken += 1;
      continue;
    }
    const problems = lintContract(loaded.contract, { limits, bytes: loaded.bytes, expectId: id, backlog, testPaths: config.verify?.test_paths });
    for (const p of problems) {
      out(formatProblem(id, p));
      if (p.level === 'error') errors += 1; else warnings += 1;
    }
    recordEvent(root, { stage: 'plan', type: 'lint', feature: id, data: lintEventData(loaded.contract, problems) }, { config, warn: err });
  }
  out(`lint-contract: ${ids.length - broken} checked, ${errors} error(s), ${warnings} warning(s)${broken ? `, ${broken} unreadable` : ''}`);
  if (broken) return 2;
  return errors ? 1 : 0;
}
