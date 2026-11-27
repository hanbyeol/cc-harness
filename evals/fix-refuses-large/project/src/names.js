import { greet } from './greet.js';

// Names from a comma-separated list, trimmed, each greeted once.
export function greetList(list) {
  return [...new Set(list.split(',').map((s) => s.trim()).filter(Boolean))].map((n) => greet(n));
}
