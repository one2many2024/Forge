#!/usr/bin/env bash
# forge-scope.sh — compute the changed-file set for a forge run and classify it.
#
# This is the real, deterministic form of forge's token lever #1 (diff-scoping) and
# lever #3 (conditional specialist fan-out): instead of trusting the model to "review
# only the diff", the review battery is fed this exact set, and domain specialists are
# gated on the TOUCHES_* flags. Portable across repos, no external deps beyond git.
#
# Usage:
#   bash scripts/forge-scope.sh [base-ref]      # base-ref defaults to "main"
#
# Output (stdout) — a small report the run parses:
#   BASE=<resolved ref>
#   FILES=<count>
#   TOUCHES_DB=<0|1>     migrations / *.sql / supabase
#   TOUCHES_API=<0|1>    api route handlers
#   TOUCHES_AUTH=<0|1>   auth / rls / middleware / proxy
#   TOUCHES_PERF=<0|1>   rendering / db / api / worker-queue-cron heuristics
#   --- changed files ---
#   <one repo-relative path per line>
#
# Exit: 0 on success (an empty set is a valid answer). Diagnostics go to stderr.

set -uo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "forge-scope: not inside a git work tree" >&2
  exit 1
fi

BASE="${1:-main}"

# Resolve the base ref: prefer a local ref, fall back to origin/<base>.
if ! git rev-parse --verify --quiet "$BASE" >/dev/null 2>&1; then
  if git rev-parse --verify --quiet "origin/$BASE" >/dev/null 2>&1; then
    BASE="origin/$BASE"
  else
    echo "forge-scope: base ref '$BASE' not found (local or origin); using working-tree changes only" >&2
    BASE=""
  fi
fi

# Collect three sources of change and union them:
#   1. committed since the merge-base with BASE (three-dot)
#   2. working tree vs HEAD (staged + unstaged)
#   3. untracked, honoring .gitignore
{
  if [ -n "$BASE" ]; then
    git diff --name-only "$BASE"...HEAD 2>/dev/null
  fi
  git diff --name-only HEAD 2>/dev/null
  git ls-files --others --exclude-standard 2>/dev/null
} | sed '/^$/d' | sort -u > /tmp/forge-scope.$$ || true

FILES_LIST="$(cat /tmp/forge-scope.$$ 2>/dev/null || true)"
rm -f /tmp/forge-scope.$$
COUNT="$(printf '%s\n' "$FILES_LIST" | sed '/^$/d' | wc -l | tr -d ' ')"

# Classify. `match <regex>` returns 0/1 over the changed-file set (case-insensitive).
match() {
  if [ -z "$FILES_LIST" ]; then echo 0; return; fi
  if printf '%s\n' "$FILES_LIST" | grep -qiE "$1"; then echo 1; else echo 0; fi
}

TOUCHES_DB="$(match 'migrations/|\.sql$|supabase/')"
TOUCHES_API="$(match '/api/|(^|/)routes?/|route\.(ts|js|tsx)$')"
TOUCHES_AUTH="$(match 'auth|(^|/)rls|middleware|proxy\.|rbac|permission')"

# Perf is relevant to rendering, data-access, and background work; skip it for pure
# docs/config/type-only diffs to save a lens that would find nothing.
if [ "$TOUCHES_DB" = "1" ] || [ "$TOUCHES_API" = "1" ] \
   || [ "$(match '\.(tsx|jsx)$|query|repository|worker|queue|batch|cron|cache|loop|index\.ts$')" = "1" ]; then
  TOUCHES_PERF=1
else
  TOUCHES_PERF=0
fi

printf 'BASE=%s\n' "${BASE:-<none>}"
printf 'FILES=%s\n' "$COUNT"
printf 'TOUCHES_DB=%s\n' "$TOUCHES_DB"
printf 'TOUCHES_API=%s\n' "$TOUCHES_API"
printf 'TOUCHES_AUTH=%s\n' "$TOUCHES_AUTH"
printf 'TOUCHES_PERF=%s\n' "$TOUCHES_PERF"
printf -- '--- changed files ---\n'
printf '%s\n' "$FILES_LIST" | sed '/^$/d'
