import { greet } from './greet.js';

// One greeting per line.
export function formatAll(names) {
  return names.map((n) => greet(n)).join('\n');
}
