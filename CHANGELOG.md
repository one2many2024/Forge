# Changelog

## 0.3.1

- Split the single `/forge:forge` command into two explicit modes:
  - **`/forge:build "<task>"`** — the interactive arc, unchanged in spirit from 0.1.0: babysitter
    **PLAN** (reuse-audit → author process → present → pause for approval) then **EXECUTE**
    (review battery, TDD-first, full gate, human breakpoints, do-NOT-merge PR), closing with the
    gap-audit.
  - **`/forge:ship "<task>" [+<budget>]`** — new autonomous mode. Runs the same arc with no
    human breakpoints, driven by a deterministic Workflow engine (`workflows/forge-auto.js`).
    Adversarially verifies CRITICAL/HIGH findings with 2–3 independent refutation votes before
    counting them as real. Enforces hard mid-flight ceilings on agent count and token budget
    (750k output tokens by default; wider with `+<budget>`) — hitting either aborts to the ship
    step and opens the PR with what it has, reporting the cap reason. Depth scales to the diff;
    gate runs a bounded FAST repair loop plus a SLOW pass at most once, never in a loop.
  - **`/forge:help`** — new. Prints the full usage guide for both modes and when to use each.
- Added `scripts/forge-scope.sh` — deterministic changed-file set + `TOUCHES_DB/API/AUTH/PERF`
  flags, replacing model self-reported diff scoping. Domain specialists are now gated on these
  flags rather than always fanning out.
- Added `scripts/gate-summary.sh` — wraps each gate command and emits only its verdict (one line
  on pass, filtered failing excerpt on fail), keeping kilobytes of green log out of context.
- The bare command name `/forge:forge` no longer exists.

## 0.1.0

- Initial release.
- `/forge:forge "<task>"` — the two-step orchestration arc: babysitter **PLAN** (Phase 0
  reuse-audit → author process → present → pause for approval) then **EXECUTE** (drive the
  run with the review battery, TDD-first, full gate, human breakpoints, do-NOT-merge PR),
  closing with an **"anything left out?"** gap-audit.
- Bundles six repo-agnostic review agents: `code-reviewer`, `security-reviewer`,
  `typescript-reviewer`, `performance-optimizer`, `refactor-cleaner`, `silent-failure-hunter`.
- Preflight checks for the required **babysitter** plugin and degrades gracefully when an
  optional gate or named agent is absent.
