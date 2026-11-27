// F187: the auto and build skills start a builder as subagent_type cc-harness:builder (never a
// fork that inherits the conversation), and the auto skill sends a push notification when a
// pass stops for a user decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
// Whitespace-insensitive: documents wrap lines at different columns.
const flat = (s) => s.replace(/\s+/g, ' ');

// The body of a "## heading" section, up to the next "## " heading.
function section(text, heading) {
  const at = text.indexOf(`\n${heading}\n`);
  assert.notEqual(at, -1, `no section ${heading}`);
  const rest = text.slice(at + heading.length + 2);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

// Paragraphs: blocks separated by blank lines; a numbered list item counts as its own paragraph.
const paragraphs = (text) => text.split(/\n\s*\n|\n(?=\d+\. )/).map(flat);

function assertBuilderType(label, text) {
  const t = flat(text);
  assert.ok(t.includes('`cc-harness:builder`'), `${label} lacks subagent_type cc-harness:builder`);
  assert.match(t, /subagent_type/, `${label} lacks subagent_type`);
  assert.match(t, /not (as )?a fork|never (as )?a fork|not with (a )?fork|do not fork/i, `${label} does not forbid a fork`);
  assert.match(t, /`fork`/, `${label} does not name subagent_type fork`);
  assert.match(t, /inherit/i, `${label} does not name the inherited conversation`);
  assert.match(t, /only the contract and (its|the) worktree/i, `${label} lacks the reason`);
}

test('F187 AC-1 the auto skill and the build skill Parallel section start the builder as cc-harness:builder, not a fork', () => {
  assertBuilderType('skills/auto/SKILL.md', read('skills/auto/SKILL.md'));
  assertBuilderType('skills/build/SKILL.md ## Parallel', section(read('skills/build/SKILL.md'), '## Parallel'));
});

test('F187 AC-2 the auto skill sends a PushNotification when a pass stops for the user, and none when there is nothing to do', () => {
  const ps = paragraphs(read('skills/auto/SKILL.md'));
  const notify = ps.find((p) => p.includes('PushNotification'));
  assert.ok(notify, 'skills/auto/SKILL.md lacks PushNotification');
  for (const s of ['blocked', 'outside this repository', 'destructive', 'feature id', 'reason', 'one line']) {
    assert.ok(notify.includes(s), `notification paragraph lacks ${JSON.stringify(s)}`);
  }
  assert.match(notify, /when (the tool|it) is (not available|missing|absent)[^.]*skip/i, 'no skip when the tool is missing');
  const nothing = ps.find((p) => /nothing to do/.test(p));
  assert.ok(nothing, 'no "nothing to do" paragraph');
  assert.match(nothing, /(no|do not send a|without a) (push )?notification/i, 'nothing to do still notifies');
  assert.ok(!/nothing to do/.test(notify) || /no notification/i.test(notify), 'notification paragraph would notify on nothing to do');
});

test('F187 AC-3 SPEC 8.13 describes the builder subagent_type and the push notification', () => {
  const spec = read('docs/SPEC.md');
  const at = spec.indexOf('### 8.13 ');
  assert.notEqual(at, -1, 'SPEC lacks 8.13');
  const s = spec.slice(at, spec.indexOf('\n### ', at + 1));
  const skill = s.slice(s.indexOf('**`auto` 스킬**'));
  assert.ok(skill.includes('cc-harness:builder'), 'SPEC 8.13 auto skill lacks cc-harness:builder');
  assert.ok(skill.includes('PushNotification'), 'SPEC 8.13 auto skill lacks PushNotification');
  assert.ok(skill.includes('subagent_type'), 'SPEC 8.13 auto skill lacks subagent_type');
});

test('F187 ES-1 the auto skill still reports the stop reason when the notification cannot be sent', () => {
  const ps = paragraphs(read('skills/auto/SKILL.md'));
  const p = ps.find((x) => x.includes('notification') && /\b(still|anyway)\b/.test(x));
  assert.ok(p, 'no paragraph with "notification" and "still"/"anyway"');
  assert.match(p, /fail/i, 'the paragraph does not cover a failed notification');
  assert.match(p, /report/i, 'the paragraph does not say the reason is reported');
});
