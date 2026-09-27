// Support for test/stress.mjs's abnormal-exit report (F52 AC-2): keep only the trailing
// STDERR_TAIL_CHARS of a crashed run's stderr, so the printed diagnostic stays bounded.
export const STDERR_TAIL_CHARS = 2000;

export function appendTail(tail, chunk) {
  return (tail + chunk).slice(-STDERR_TAIL_CHARS);
}
