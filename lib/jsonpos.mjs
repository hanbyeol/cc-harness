// Offset of the first JSON syntax error, for messages where V8 gives none
// (e.g. `Unexpected token 'x', ..." is not valid JSON`). Returns null if `text` parses.
// Only locates the error; JSON.parse remains the authority on validity.
export function jsonErrorOffset(text) {
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i += 1; };
  const fail = () => { throw i; };
  const lit = (word) => { for (const ch of word) { if (text[i] !== ch) fail(); i += 1; } };
  const str = () => {
    i += 1; // opening quote
    while (i < text.length && text[i] !== '"') {
      const c = text.charCodeAt(i);
      if (c < 0x20) fail();
      if (text[i] === '\\') {
        i += 1;
        if (text[i] === 'u') { for (let k = 1; k <= 4; k += 1) if (!/[0-9a-fA-F]/.test(text[i + k] ?? '')) { i += k; fail(); } i += 5; continue; }
        if (!'"\\/bfnrt'.includes(text[i] ?? '')) fail();
      }
      i += 1;
    }
    if (i >= text.length) fail();
    i += 1;
  };
  const num = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail();
    i += m[0].length;
  };
  const value = () => {
    ws();
    const ch = text[i];
    if (ch === '{') {
      i += 1; ws();
      if (text[i] === '}') { i += 1; return; }
      for (;;) {
        ws(); if (text[i] !== '"') fail(); str();
        ws(); if (text[i] !== ':') fail(); i += 1;
        value(); ws();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === '}') { i += 1; return; }
        fail();
      }
    }
    if (ch === '[') {
      i += 1; ws();
      if (text[i] === ']') { i += 1; return; }
      for (;;) {
        value(); ws();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ']') { i += 1; return; }
        fail();
      }
    }
    if (ch === '"') return str();
    if (ch === 't') return lit('true');
    if (ch === 'f') return lit('false');
    if (ch === 'n') return lit('null');
    if (ch === '-' || (ch >= '0' && ch <= '9')) return num();
    fail();
  };
  try {
    value(); ws();
    if (i < text.length) fail();
    return null;
  } catch (pos) {
    if (typeof pos !== 'number') throw pos;
    return Math.min(pos, text.length);
  }
}
