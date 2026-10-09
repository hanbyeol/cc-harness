// Small helpers shared across lib/ — one definition each.

import crypto from 'node:crypto';

/** A plain object: not null, not an array. */
export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The first 16 hex characters of the SHA-256 of `text`. */
export const sha16 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);

/** Median of numbers: the middle value, or the mean of the two middle values; null when empty. */
export function median(values) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** `s` with every regular-expression metacharacter escaped. */
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
