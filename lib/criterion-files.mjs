// Support for test/t.mjs (F78): the test files a criterion check loads.
import fs from 'node:fs';

// test/**/*.test.mjs under `root` (relative, '/'-separated, sorted) whose source contains
// `id`. A file that cannot be read is included: a missed verdict is worse than a slower run.
export function selectTestFiles(root, id, read = fs.readFileSync) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(`${root}/${rel}`, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith('.test.mjs')) {
        let src;
        try { src = read(`${root}/${child}`, 'utf8'); } catch { out.push(child); continue; }
        if (src.includes(id)) out.push(child);
      }
    }
  };
  walk('test');
  return out;
}
