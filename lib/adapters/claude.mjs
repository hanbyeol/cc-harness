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

// Tools a role session never uses, also denied so their definitions stay out of its context
// (SPEC §10). The builder keeps ScheduleWakeup, Monitor and ToolSearch to wait on long runs.
export const UNUSED_TOOLS = Object.freeze({
  write: Object.freeze(['Workflow', 'Skill', 'ReportFindings', 'ListAgents', 'Agent']),
  readOnly: Object.freeze(['Workflow', 'ScheduleWakeup', 'Skill', 'ReportFindings', 'ListAgents', 'Agent']),
});

const adapter = {
  name: 'claude',
  bin: 'claude',
  helpArgs: ['--help'],
  // The schema goes to the CLI (--json-schema), which returns the object through its
  // StructuredOutput tool: the evaluation prompt asks for that call instead of JSON text.
  structuredOutput: true,
  buildArgs({ readOnly = false, schema, budgetUsd, model, effort } = {}) {
    // No MCP servers (none from --mcp-config) and no skills in a role session.
    const args = ['-p', '--strict-mcp-config', '--disable-slash-commands'];
    if (readOnly) args.push('--permission-mode', 'plan', '--disallowedTools', ...UNUSED_TOOLS.readOnly);
    else args.push('--permission-mode', 'auto', '--disallowedTools', ...DENY, ...UNUSED_TOOLS.write);
    args.push('--output-format', 'json');
    if (schema) args.push('--json-schema', JSON.stringify(schema));
    if (budgetUsd != null) args.push('--max-budget-usd', String(budgetUsd));
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    return args;
  },
  requiredFlags({ readOnly = false, schema, budgetUsd, model, effort } = {}) {
    const req = ['-p', '--strict-mcp-config', '--disable-slash-commands', `--permission-mode=${readOnly ? 'plan' : 'auto'}`,
      '--disallowedTools', '--output-format=json'];
    if (schema) req.push('--json-schema');
    if (budgetUsd != null) req.push('--max-budget-usd');
    if (model) req.push('--model');
    if (effort) req.push('--effort');
    return req;
  },
  run(opts) {
    return runAdapter(adapter, opts);
  },
};

export default adapter;
