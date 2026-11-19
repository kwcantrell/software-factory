// PreToolUse hook entry (hooks/hooks.json runs it with node): reads the payload on stdin and prints
// a permission prompt for `factory merge`, `factory approve` and `factory rework`, or nothing. It
// never fails the tool call: any error means no output and exit 0. The rules are in gate.ts.
import { readFileSync } from 'node:fs';
import { decide } from './gate.ts';

let payload = '';
try {
  payload = readFileSync(0, 'utf8');
} catch {
  // no stdin: nothing to decide
}
process.stdout.write(decide(payload));
