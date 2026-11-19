#!/bin/sh
# Every check CI runs, in one command: scripts/check.sh (from anywhere in the repo).
# Exits non-zero if any check fails. Needs git, Node.js 22.18+ with npm (run `npm ci` first),
# python3 (for the release check, until it moves to TypeScript) and the `claude` CLI.
# When shellcheck is installed it lints the shell scripts; otherwise that step is skipped with a note.
set -u
cd "$(dirname "$0")/.." || exit 1

failed=""
step() { printf '\n== %s\n' "$1"; }
fail() { printf 'FAILED: %s\n' "$1"; failed="$failed
  - $1"; }

step "every JSON file parses"
# Tracked and untracked-but-not-ignored files, so a new broken file is caught before it is committed.
if ! git ls-files -z --cached --others --exclude-standard -- '*.json' | node -e '
const { readFileSync } = require("node:fs");
let bad = 0;
const names = readFileSync(0).toString("utf8").split("\0").filter(Boolean);
for (const path of names) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { continue; } // deleted in the working tree but still in the index
  try { JSON.parse(text); console.log("ok  ", path); }
  catch (e) { console.log("BAD ", path, "-", e.message); bad = 1; }
}
process.exit(bad);
'; then
  fail "JSON parse"
fi

step "marketplace and plugin manifests (claude plugin validate)"
if ! command -v claude >/dev/null 2>&1; then
  fail "claude plugin validate: the claude CLI is not installed (npm install -g @anthropic-ai/claude-code)"
else
  if ! claude plugin validate .; then
    fail "claude plugin validate ."
  fi
  for plugin in plugins/*/; do
    if ! claude plugin validate "${plugin%/}"; then
      fail "claude plugin validate ${plugin%/}"
    fi
  done
fi

step "typecheck (npm run typecheck)"
if ! npm run --silent typecheck; then
  fail "typecheck"
fi

step "plugin tests (npm test)"
if ! npm test --silent; then
  fail "npm test"
fi

step "byte-compile scripts/*.py"
for f in scripts/*.py; do
  # Compiled in memory, so no __pycache__ is written.
  if python3 -I -c 'import sys; compile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")' "$f"; then
    echo "ok   $f"
  else
    fail "byte-compile $f"
  fi
done

step "shellcheck"
# shellcheck disable=SC2046 # word splitting is wanted: one argument per script
if ! command -v shellcheck >/dev/null 2>&1; then
  echo "SKIPPED: shellcheck is not installed (CI installs it)"
elif shellcheck $(git ls-files --cached --others --exclude-standard -- '*.sh'); then
  echo "ok"
else
  fail "shellcheck"
fi

step "release check: plugin.json version has a CHANGELOG.md section"
if python3 -I scripts/release.py >/dev/null; then
  echo "ok"
else
  fail "release check"
fi

step "release script tests (python3 -I -B -m unittest discover -s tests)"
if ! python3 -I -B -m unittest discover -s tests; then
  fail "release script tests"
fi

if [ -n "$failed" ]; then
  printf '\nchecks FAILED:%s\n' "$failed"
  exit 1
fi
printf '\nall checks passed\n'
