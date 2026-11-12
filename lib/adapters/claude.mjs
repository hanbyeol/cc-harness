// Claude Code adapter. Every flag below appears in `claude --help` (2.1.314,
// fixture test/fixtures/help/claude-2.1.314.txt). The prompt is sent on stdin.
import { runAdapter } from './common.mjs';

// Native deny list for the writable builder session (SPEC §10 <deny>).
export const DENY = Object.freeze([
  'Bash(git push:*)',
  'Bash(git reset --hard:*)',
  'Bash(rm -rf /:*)',
  'Bash(rm -rf ~:*)',
  'Bash(sudo:*)',
  // The builder is headless: the interactive harness workflow is not its job (SPEC §10).
  'Bash(harness:*)',
  'Bash(cc-harness:*)',
  'Bash(npx cc-harness:*)',
  'Bash(npx github:hanbyeol/cc-harness:*)',
  'Bash(node bin/harness.mjs:*)',
]);

// Tools a role session never uses, also denied so their definitions stay out of its context
// (SPEC §10). The builder keeps ScheduleWakeup, Monitor and ToolSearch to wait on long runs.
const NEVER_USED = ['CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', 'PushNotification', 'SendMessage', 'DesignSync', 'EnterWorktree', 'ExitWorktree'];
export const UNUSED_TOOLS = Object.freeze({
  write: Object.freeze(['Workflow', 'Skill', 'ReportFindings', 'ListAgents', 'Agent', ...NEVER_USED]),
  // Plan mode alone does not keep a read-only session from writing: the auto mode classifier
  // can approve a tool there (SPEC §10), so the file writing tools are denied as well.
  readOnly: Object.freeze(['Workflow', 'ScheduleWakeup', 'Skill', 'ReportFindings', 'ListAgents', 'Agent', ...NEVER_USED, 'Edit', 'Write', 'NotebookEdit']),
});

// No user or plugin hooks and no auto-memory in a role session (SPEC §10): a memory the builder
// leaves must not reach the evaluator. Only these two keys, so permissions are not overridden.
const SETTINGS = JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false });

// `claude auth status --json` (measured 2.1.322, no model call): {loggedIn, authMethod, ...}
// with exit 0 when logged in (an ANTHROPIC_API_KEY counts: authMethod 'api_key') and exit 1
// when not. Returns {ok, via} or {ok: false, reason}, or null when the output is not that JSON
// (an older CLI without `auth`): unknown never blocks a role (SPEC §10). Only loggedIn and
// authMethod are read, so the account's email and organization never reach doctor's output.
export function authFromStatus(status) {
  let j;
  try {
    j = JSON.parse(String(status?.stdout ?? '').trim());
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || typeof j.loggedIn !== 'boolean') return null;
  if (!j.loggedIn) return { ok: false, reason: 'not authenticated (run `claude auth login` or set ANTHROPIC_API_KEY)' };
  const via = typeof j.authMethod === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(j.authMethod) ? j.authMethod : 'claude';
  return { ok: true, via };
}

const adapter = {
  name: 'claude',
  bin: 'claude',
  helpArgs: ['--help'],
  // doctor's auth check without a model call (SPEC §10).
  authArgs: ['auth', 'status', '--json'],
  authFromStatus,
  // The schema goes to the CLI (--json-schema), which returns the object through its
  // StructuredOutput tool: the evaluation prompt asks for that call instead of JSON text.
  structuredOutput: true,
  requiresResult: true,
  buildArgs({ readOnly = false, schema, budgetUsd, model, effort } = {}) {
    // No MCP servers (none from --mcp-config) and no skills in a role session.
    const args = ['-p', '--strict-mcp-config', '--disable-slash-commands', '--settings', SETTINGS];
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
    const req = ['-p', '--strict-mcp-config', '--disable-slash-commands', '--settings', `--permission-mode=${readOnly ? 'plan' : 'auto'}`,
      '--disallowedTools', '--output-format=json'];
    if (schema) req.push('--json-schema');
    if (budgetUsd != null) req.push('--max-budget-usd');
    if (model) req.push('--model');
    if (effort) req.push('--effort');
    return req;
  },
  // A usage limit (SPEC §8): the wrapper is an error whose api_error is 'usage_limit_reached' or
  // whose api_error_status is 429. Returns the wrapper's result sentence, or null when it is not one.
  usageLimit(w) {
    if (!w || typeof w !== 'object' || w.type !== 'result' || w.is_error !== true) return null;
    if (w.api_error === undefined || w.api_error === null) return null;
    if (w.api_error !== 'usage_limit_reached' && w.api_error_status !== 429) return null;
    return typeof w.result === 'string' && w.result.trim() ? w.result.trim() : 'usage limit reached';
  },
  // A model refusal (SPEC §8): the wrapper's stop_reason is 'refusal', whatever is_error and the
  // exit code say. Returns its result sentence and safety_stops count, or null when it is not one.
  refusal(w) {
    if (!w || typeof w !== 'object' || w.type !== 'result' || w.stop_reason !== 'refusal') return null;
    const text = typeof w.result === 'string' && w.result.trim() ? w.result.trim() : 'the model refused';
    return { text, safetyStops: Number.isInteger(w.safety_stops) ? w.safety_stops : 0 };
  },
  // An error wrapper (SPEC §10, measured 2.1.322): `subtype` names how the run ended
  // ('error_max_budget_usd', 'error_max_turns', …) and `errors` holds the CLI's sentences.
  // Returns {detail: '<subtype>: <errors joined by "; ">', budgetExhausted}, or null when the
  // wrapper is not an error with a subtype.
  errorWrapper(w) {
    if (!w || typeof w !== 'object' || w.type !== 'result' || w.is_error !== true) return null;
    if (typeof w.subtype !== 'string' || !w.subtype || w.subtype === 'success') return null;
    const errors = Array.isArray(w.errors) ? w.errors.filter((e) => typeof e === 'string' && e.trim()).map((e) => e.trim()) : [];
    return { detail: errors.length ? `${w.subtype}: ${errors.join('; ')}` : w.subtype, budgetExhausted: w.subtype === 'error_max_budget_usd' };
  },
  run(opts) {
    // A refusal ends the call as a 'refusal' error instead of the CLI switching models silently (SPEC §10).
    return runAdapter(adapter, { ...opts, cliEnv: { CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1' } });
  },
};

export default adapter;
