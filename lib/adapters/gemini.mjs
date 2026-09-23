// Gemini CLI adapter. Every flag below appears in `gemini --help` (0.38.1,
// fixture test/fixtures/help/gemini-0.38.1.txt).
// `-p/--prompt` "Run in non-interactive (headless) mode with the given prompt. Appended to
// input on stdin (if any)." — so `-p ""` selects headless mode and the real prompt arrives
// on stdin (measured: `-p ""` is accepted by the parser).
// No structured-output or budget flag exists: JSON is extracted from the `-o json` wrapper's
// `response` text, and cost is bounded by timeout only.
import { runAdapter } from './common.mjs';

const adapter = {
  name: 'gemini',
  bin: 'gemini',
  helpArgs: ['--help'],
  buildArgs({ readOnly = false, model } = {}) {
    const args = ['-p', ''];
    if (readOnly) args.push('--approval-mode', 'plan');
    else args.push('--approval-mode', 'yolo', '-s');
    args.push('-o', 'json');
    if (model) args.push('-m', model);
    return args;
  },
  requiredFlags({ readOnly = false, model } = {}) {
    const req = ['-p', `--approval-mode=${readOnly ? 'plan' : 'yolo'}`, '-o=json'];
    if (!readOnly) req.push('-s');
    if (model) req.push('-m');
    return req;
  },
  run(opts) {
    return runAdapter(adapter, opts);
  },
};

export default adapter;
