// Claude Code adapter. Every flag below appears in `claude --help` (2.1.280,
// fixture test/fixtures/help/claude-2.1.280.txt). The prompt is sent on stdin.
import { runAdapter } from './common.mjs';

// Native deny list for the writable builder session (SPEC §10 <deny>).
export const DENY = Object.freeze([
  'Bash(git push:*)',
  'Bash(git reset --hard:*)',
  'Bash(rm -rf /:*)',
  'Bash(rm -rf ~:*)',
  'Bash(sudo:*)',
]);

const adapter = {
  name: 'claude',
  bin: 'claude',
  helpArgs: ['--help'],
  buildArgs({ readOnly = false, schema, budgetUsd, model } = {}) {
    const args = ['-p'];
    if (readOnly) args.push('--permission-mode', 'plan');
    else args.push('--permission-mode', 'auto', '--disallowedTools', ...DENY);
    args.push('--output-format', 'json');
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    if (budgetUsd != null) args.push('--max-budget-usd', String(budgetUsd));
    if (model) args.push('--model', model);
    return args;
  },
  requiredFlags({ readOnly = false, schema, budgetUsd, model } = {}) {
    const req = ['-p', `--permission-mode=${readOnly ? 'plan' : 'auto'}`, '--output-format=json'];
    if (!readOnly) req.push('--disallowedTools');
    if (schema) req.push('--json-schema');
    if (budgetUsd != null) req.push('--max-budget-usd');
    if (model) req.push('--model');
    return req;
  },
  run(opts) {
    return runAdapter(adapter, opts);
  },
};

export default adapter;
