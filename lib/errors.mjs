// Errors the CLI reports to the user. `exit` is the process exit code;
// anything that is not a HarnessError is an internal bug (exit 1).
export class HarnessError extends Error {
  constructor(message, { code = 'error', exit = 2 } = {}) {
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.exit = exit;
  }
}
