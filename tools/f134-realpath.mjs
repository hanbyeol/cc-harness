// Static form of F134 AC-2: lines of a source text that call the non-native realpath.
import fs from 'node:fs';
import path from 'node:path';

// Built from parts so this file does not contain the forbidden spelling itself.
const CALL = 'real' + 'pathSync';

// Lines (1-based numbers) of `text` that call the non-native realpath and are not comments.
export function violations(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (line.includes(CALL + '(')) out.push(i + 1);
  });
  return out;
}

export function mjsFiles(dir) {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...mjsFiles(p));
    else if (e.name.endsWith('.mjs')) files.push(p);
  }
  return files;
}
