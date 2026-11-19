// Output formatting that matches the original CLI byte for byte, so job.json files and command output
// stay identical across the port: JSON with indent 2 and non-ASCII escaped, floats that keep their
// ".0", round-half-even rounding, and the "g" and "%" number formats used by `factory stats`.

/** A number that prints as a float (1 -> "1.0"), like a Python float in JSON output. */
export class Float {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

function floatRepr(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return `${v}.0`;
  return String(v);
}

/** JSON string literal with every character outside printable ASCII escaped as \uXXXX. */
function quote(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** JSON text with indent 2, as the job records and `--json` output have always been written. */
export function dumps(value: unknown, level = 0): string {
  const pad = '  '.repeat(level + 1);
  const end = '  '.repeat(level);
  if (value === null || value === undefined) return 'null';
  if (value instanceof Float) return floatRepr(value.value);
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return Number.isInteger(value) ? String(value) : floatRepr(value);
    case 'string':
      return quote(value);
    default:
      break;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((v) => pad + dumps(v, level + 1)).join(',\n')}\n${end}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, v]) => `${pad}${quote(k)}: ${dumps(v, level + 1)}`).join(',\n')}\n${end}}`;
}

/** Round to `digits` decimals, half to even on the exact binary value (Python's round()). */
export function roundHalfEven(x: number, digits: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  const exact = Math.abs(x).toFixed(100);
  const [whole = '0', frac = ''] = exact.split('.');
  const rest = frac.slice(digits);
  let kept = BigInt(whole + frac.slice(0, digits));
  const first = rest[0] ?? '0';
  const tail = /[1-9]/.test(rest.slice(1));
  if (first > '5' || (first === '5' && tail) || (first === '5' && !tail && kept % 2n === 1n)) kept += 1n;
  const digitsText = kept.toString().padStart(digits + 1, '0');
  const text = digits === 0 ? digitsText : `${digitsText.slice(0, -digits)}.${digitsText.slice(-digits)}`;
  const result = Number(text);
  return x < 0 ? -result : result;
}

/** Python's format(v, "g"): six significant digits, trailing zeros dropped. */
export function formatG(v: number): string {
  if (v === 0) return '0';
  const [, expText = '0'] = v.toExponential(5).split('e');
  const exp = Number(expText);
  const strip = (s: string): string => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  if (exp < -4 || exp >= 6) {
    const [mantissa = '0'] = v.toExponential(5).split('e');
    return `${strip(mantissa)}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  return strip(v.toFixed(5 - exp));
}

/** Python's format(v, ".0%"). */
export function formatPercent(v: number): string {
  return `${roundHalfEven(v * 100, 0).toFixed(0)}%`;
}

/** How Python's str() shows a value inside an f-string: null is "None". */
export function str(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return String(v);
}
