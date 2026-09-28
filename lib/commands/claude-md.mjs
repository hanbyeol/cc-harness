// `harness claude-md [--check]` — write (or check) the managed block of the project's
// CLAUDE.md from the harness's templates/claude-block.md (SPEC §4.1).
import { isInitialized } from '../state.mjs';
import { loadConfig } from '../config.mjs';
import { HarnessError } from '../errors.mjs';
import { blockStatus, updateClaudeMd } from '../claudemd.mjs';

const USAGE = 'usage: harness claude-md [--check]';

export default async function claudeMd({ root, args = [], out, err = () => {}, fsImpl }) {
  const unknown = args.filter((a) => a !== '--check');
  if (unknown.length) throw new HarnessError(`unknown option ${unknown[0]}\n${USAGE}`, { code: 'usage' });
  if (args.includes('--check')) {
    const s = blockStatus(root);
    out(s.state === 'current' ? s.reason : `${s.reason} — run \`harness claude-md\``);
    return s.state === 'current' ? 0 : 1;
  }
  const { language, profile } = isInitialized(root) ? loadConfig(root) : {};
  const r = updateClaudeMd(root, { language, profile, fsImpl, warn: (m) => err(`harness: warning: ${m}`) });
  const { current } = blockStatus(root, { profile });
  const messages = {
    created: `created CLAUDE.md with the cc-harness block (v${current})`,
    inserted: `added the cc-harness block (v${current}) to CLAUDE.md`,
    updated: `updated the cc-harness block in CLAUDE.md (${r.from ? `v${r.from}` : 'unversioned'} → v${current})`,
    unchanged: `CLAUDE.md block is current (v${current}); nothing changed`,
  };
  out(messages[r.action]);
  return 0;
}
