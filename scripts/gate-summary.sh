#!/usr/bin/env bash
# gate-summary.sh — run a gate command and emit ONLY its verdict.
#
# This is the real form of forge's token lever #2: the gate stage (unit/lint/tsc/
# build/e2e) is usually the largest single token dump in a run, and ~all of it is
# noise on a pass. This wrapper keeps kilobytes of green log out of the orchestrator
# context — on pass it prints one line; on failure it prints the exit code plus only
# the lines that look like errors/failures (bounded). Portable across repos.
#
# Usage:
#   bash scripts/gate-summary.sh "<label>" "<command>"
#   bash scripts/gate-summary.sh "unit"    "npm test"
#   bash scripts/gate-summary.sh "tsc.ci"  "npx tsc --noEmit -p tsconfig.ci.json"
#
# Env:
#   GATE_SUMMARY_MAX_LINES  max excerpt lines on failure (default 40)
#
# Exit: mirrors the wrapped command's exit code, so the run can branch on pass/fail.

set -uo pipefail

LABEL="${1:?usage: gate-summary.sh <label> <command>}"
CMD="${2:?usage: gate-summary.sh <label> <command>}"
MAX_LINES="${GATE_SUMMARY_MAX_LINES:-40}"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# Run the gate, capturing combined stdout+stderr. Do not let a non-zero exit abort us.
bash -c "$CMD" >"$TMP" 2>&1
CODE=$?

if [ "$CODE" -eq 0 ]; then
  SUPPRESSED="$(wc -l < "$TMP" | tr -d ' ')"
  printf 'PASS  [%s]  $ %s  (%s lines suppressed)\n' "$LABEL" "$CMD" "$SUPPRESSED"
  exit 0
fi

printf 'FAIL  [%s]  exit=%s  $ %s\n' "$LABEL" "$CODE" "$CMD"
printf -- '----- failing excerpt (filtered) -----\n'
FILTERED="$(grep -niE 'error|fail|✗|✘|✖|assert|expected|received|unhandled|cannot|TS[0-9]{3,}' "$TMP" | tail -n "$MAX_LINES" || true)"
if [ -n "$FILTERED" ]; then
  printf '%s\n' "$FILTERED"
else
  printf '(no error-pattern lines matched; last %s lines of output:)\n' "$MAX_LINES"
  tail -n "$MAX_LINES" "$TMP"
fi
printf -- '----- end excerpt -----\n'
exit "$CODE"
