// Git-style globs over repo-relative POSIX paths: `**/` spans any number of directories (including
// none), a trailing or inner `**` matches anything, `*` and `?` stay within one path segment, and
// everything else is literal. A pattern matches the whole path.

const cache = new Map<string, RegExp>();

export function globSource(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
    } else if (pattern.startsWith('**', i)) {
      out += '.*';
      i += 2;
    } else if (pattern[i] === '*') {
      out += '[^/]*';
      i += 1;
    } else if (pattern[i] === '?') {
      out += '[^/]';
      i += 1;
    } else {
      out += (pattern[i] ?? '').replace(/[\\^$.*+?()[\]{}|/]/, '\\$&');
      i += 1;
    }
  }
  return `^(?:${out})$`;
}

export function globRe(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (!re) {
    re = new RegExp(globSource(pattern), 'su');
    cache.set(pattern, re);
  }
  return re;
}

/** True when `path` matches any of `patterns`. */
export function matches(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globRe(p).test(path));
}
