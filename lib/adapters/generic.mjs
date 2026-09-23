// Generic adapter: any headless CLI that reads its prompt on stdin, configured in
// .harness/config.json:
//   "adapters": { "generic": {
//       "command":           ["mycli", "--headless", "--auto-approve"],   // builder (writable)
//       "read_only_command": ["mycli", "--headless", "--read-only"],      // evaluator roles
//       "help_args":         ["--help"] } }                               // optional
// A read-only call with no read_only_command is refused (adapter_unavailable) rather than
// run in write mode (SR-6). JSON is extracted from stdout.
import { runAdapter } from './common.mjs';

const strings = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string') ? v : null;

export function createGenericAdapter(config = {}) {
  const conf = config?.adapters?.generic || {};
  const write = strings(conf.command);
  const readOnly = strings(conf.read_only_command);
  const variant = (ro) => (ro ? readOnly : write);

  const adapter = {
    name: 'generic',
    bin: (write || readOnly || [null])[0],
    helpArgs: strings(conf.help_args) || ['--help'],
    configured: Boolean(write || readOnly),
    buildArgs({ readOnly: ro = false } = {}) {
      const v = variant(ro);
      if (!v) throw new Error(`adapters.generic.${ro ? 'read_only_command' : 'command'} is not configured`);
      return v.slice(1);
    },
    requiredFlags({ readOnly: ro = false } = {}) {
      const v = variant(ro);
      // An unconfigured variant can never be satisfied by any help text.
      return v ? v.slice(1).filter((a) => a.startsWith('-')) : [`<adapters.generic.${ro ? 'read_only_command' : 'command'}>`];
    },
    async run(opts = {}) {
      const v = variant(Boolean(opts.readOnly));
      if (!v) {
        return { ok: false, error: 'adapter_unavailable', text: '', json: null, costUsd: null, exitCode: null,
          detail: `adapters.generic.${opts.readOnly ? 'read_only_command' : 'command'} is not configured` };
      }
      return runAdapter({ ...adapter, bin: v[0] }, opts);
    },
  };
  return adapter;
}

export default createGenericAdapter();
