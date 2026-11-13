#!/bin/sh
# The factory's human gates. Any Bash call that runs `factory merge`,
# `factory approve` or `factory rework` is turned into a permission prompt, so no
# agent can ship a job, approve a spec or reopen an approved job without a person
# saying yes.
# Reads the PreToolUse payload on stdin; stays silent for everything else.
ask() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' "$1"
}
case "$(cat)" in
  *'factory merge'*|*'factory\" merge'*|*"factory' merge"*)
    ask "Software Factory merge gate: this merges an agent-built branch into your working branch. Approve only if you have read ship.md." ;;
  *'factory approve'*|*'factory\" approve'*|*"factory' approve"*)
    ask "Software Factory spec gate: this approves a job's task.md as the contract agents will build and be judged against." ;;
  *'factory rework'*|*'factory\" rework'*|*"factory' rework"*)
    ask "Software Factory rework gate: this sends a job every reviewer approved back to build, with your request saved as rework-<round>.md." ;;
esac
exit 0
