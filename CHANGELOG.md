# Changelog

## 0.4.1

- **Fix: the `## Open items` list never parsed on a CRLF checkout.**
  `scripts/forge-summary.mjs` split `SKIPPED.md` on a bare line-feed, which leaves a
  trailing carriage return on every line under Windows/CRLF. JavaScript treats CR as a
  regex LINE TERMINATOR, so the dot in the checkbox pattern could not match it and
  EVERY item failed to parse. The section was found, zero items were collected, and
  Phase D printed **"Open items: none — all boxes checked ✅"** regardless of what the
  file actually contained.

  A silent false negative on the one section whose entire job is surfacing unfinished
  work — the summary was most confident exactly where it was blindest. It now splits on
  a CRLF-tolerant pattern.

  Two things worth knowing when auditing whether past runs were affected: the parser
  takes the **FIRST** `## Open items` heading in the file, so historical per-PR sections
  sitting above the live list will shadow it; and only `##` matches, not `###`.

## 0.4.0

- **Closing run-summary + token meter (`scripts/forge-summary.mjs`).** Every run (build and
  ship) now ends with a compact, fixed-format summary instead of a hand-tallied prose recap:
  - A **per-phase / per-step token table** (Recon / Design / Tests / Implementation / Review
    battery / Resolve / …), one row per agent, plus an **Orchestration (main-loop)** row and a
    measured **TOTAL**. Numbers are read from the authoritative on-disk meter — the Claude Code
    session transcript, which records per-turn `usage` (orchestration loop) and every subagent's
    `subagent_tokens` — so totals are **measured, not estimated**. Output tokens are the headline
    (matches the statusline `↓ tokens` + the Workflow `budget.spent()`).
  - A **rule-based defensibility verdict** (🟢 defensible / 🟡 heavy-justify / 🔴 runaway) from
    agent-count ÷ changed-files (and the budget for ship), so the 5M-on-a-one-line pattern is
    flagged automatically, not by vibe.
  - The **`## Open items`** list parsed from `SKIPPED.md`, with a 🆕 marker on items added this
    run (detected via `git diff <base> -- SKIPPED.md`).
- **`SKIPPED.md` convention:** genuinely-open / owner-action items go under a `## Open items`
  heading as `- [ ]` checkboxes (flip to `- [x]` when resolved) so the meter can parse them.
- build.md gains **Phase D — RUN SUMMARY** (always runs); ship.md prints the same block after the
  Workflow returns. The meter is journal-independent (reads only the session transcript), so it
  works identically for babysitter (build) and Workflow (ship).

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
