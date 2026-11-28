import { timingSafeEqual } from 'node:crypto';

// checkToken(given, expected) is true only when both tokens are equal.
export function checkToken(given, expected) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) throw new Error('invalid token');
  return timingSafeEqual(a, b);
}
