import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessError } from './errors.mjs';

// Role prompts ship with the package; resolve from here, never from cwd.
export const AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agents');
export const ROLES = Object.freeze(['builder', 'evaluator', 'security-reviewer']);

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

// The agents/*.md body doubles as the headless role prompt for every adapter,
// so the frontmatter (Claude/Gemini subagent metadata) is stripped here.
export function loadRolePrompt(name) {
  if (!ROLES.includes(name)) {
    throw new HarnessError(`unknown role '${name}'. Roles: ${ROLES.join(', ')}`, { code: 'unknown_role' });
  }
  const text = fs.readFileSync(path.join(AGENTS_DIR, `${name}.md`), 'utf8');
  return text.replace(FRONTMATTER, '').trim() + '\n';
}
