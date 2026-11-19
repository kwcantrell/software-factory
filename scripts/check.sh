#!/bin/sh
# Every check CI runs, in one command: scripts/check.sh (from anywhere in the repo).
# Exits non-zero if any check fails. Needs git, python3 and the `claude` CLI.
# When shellcheck is installed it lints the shell scripts; otherwise that step is skipped with a note.
set -u
cd "$(dirname "$0")/.." || exit 1

failed=""
step() { printf '\n== %s\n' "$1"; }
fail() { printf 'FAILED: %s\n' "$1"; failed="$failed
  - $1"; }

step "plugin and marketplace manifests (claude plugin validate .)"
if ! command -v claude >/dev/null 2>&1; then
  fail "claude plugin validate: the claude CLI is not installed (npm install -g @anthropic-ai/claude-code)"
elif ! claude plugin validate .; then
  fail "claude plugin validate"
fi

step "every JSON file parses"
# Tracked and untracked-but-not-ignored files, so a new broken file is caught before it is committed.
if ! git ls-files -z --cached --others --exclude-standard -- '*.json' | python3 -I -c '
import json, sys
bad = 0
for name in filter(None, sys.stdin.buffer.read().split(b"\0")):
    path = name.decode()
    try:
        with open(path, encoding="utf-8") as fh:
            json.load(fh)
        print("ok  ", path)
    except FileNotFoundError:
        pass  # deleted in the working tree but still in the index
    except ValueError as e:
        print("BAD ", path, "-", e)
        bad = 1
sys.exit(bad)
'; then
  fail "JSON parse"
fi

step "byte-compile bin/factory and scripts/*.py"
for f in bin/factory scripts/*.py; do
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

step "tests (python3 -I -B -m unittest discover -s tests)"
if ! python3 -I -B -m unittest discover -s tests; then
  fail "tests"
fi

if [ -n "$failed" ]; then
  printf '\nchecks FAILED:%s\n' "$failed"
  exit 1
fi
printf '\nall checks passed\n'
