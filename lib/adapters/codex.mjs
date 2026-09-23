// Codex CLI adapter — EXPERIMENTAL. Codex was not installed where this was written, so the
// flags are taken from its documented interface, not a measured --help:
//   codex exec [OPTIONS] [PROMPT]   — PROMPT `-` (or omitted) reads instructions from stdin
//   -s, --sandbox <read-only|workspace-write|danger-full-access>
//   -m, --model <MODEL>
// `harness doctor` checks these against `codex exec --help` before any role may use codex.
// No structured-output flag is used: JSON is extracted from the final message on stdout.
import { runAdapter } from './common.mjs';

const adapter = {
  name: 'codex',
  bin: 'codex',
  experimental: true,
  helpArgs: ['exec', '--help'],
  buildArgs({ readOnly = false, model } = {}) {
    const args = ['exec', '--sandbox', readOnly ? 'read-only' : 'workspace-write'];
    if (model) args.push('--model', model);
    args.push('-');
    return args;
  },
  requiredFlags({ readOnly = false, model } = {}) {
    const req = [`--sandbox=${readOnly ? 'read-only' : 'workspace-write'}`];
    if (model) req.push('--model');
    return req;
  },
  run(opts) {
    return runAdapter(adapter, opts);
  },
};

export default adapter;
