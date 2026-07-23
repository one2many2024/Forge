# Changelog

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
