import { greet } from './greet.js';
import { formatAll } from './format.js';

// node src/cli.js <name> [<name> ...]
const names = process.argv.slice(2);
console.log(names.length === 1 ? greet(names[0]) : formatAll(names));
