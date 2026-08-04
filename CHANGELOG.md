# Changelog

## 0.4.2

Three defects surfaced by the 2026-08-03 branch-C ship run. All three are
`/forge:ship`-only — `/forge:build` runs in-session on the live checkout and hits
none of them.

- **Fix: `/forge:ship` could not launch at all on a Windows checkout.** The
  Workflow tool's permission validator rejects a script containing control
  characters (*"script contains control characters that would be hidden in the
  approval dialog"*), and with `core.autocrlf=true` every line of
  `workflows/forge-auto.js` ends in `\r`. Ship was unlaunchable from the installed
  plugin path; the workaround was running an LF-stripped copy. `.gitattributes`
  now pins `*.js`/`*.mjs`/`*.md`/`*.json` to `eol=lf`.

  Note the error names `script`, not `args`, even when the caller passed only
  `scriptPath` — rewriting the task prompt does not help. Diagnose with Node, not
  grep: git-bash `grep -c $'\r'` reported 0 CRs on a file that had 284.

- **Fix: the gate could measure a different branch than the one under review.**
  All agents share ONE working tree, so a checkout by any of them relocates every
  later step. On the branch-C run the fast gate reported PASS for
  `docs/linkedin-export-verified` — not the feature branch — and the run then
  reported that as this branch's gate result. `scope` now returns the working
  branch, every downstream prompt (review, verify, resolve, gate, repair, slow,
  ship) is pinned to it, `GATE_SCHEMA` requires the branch each gate MEASURED, and
  a mismatch is logged and forced to red rather than inherited as green.

- **Fix: the summary meter reported `~0 agents` for every ship run.** Workflow
  agents never write `subagent_tokens` notifications into the session transcript —
  they write `agent-<id>.jsonl` under
  `<projectDir>/<sessionId>/subagents/workflows/wf_<runId>/`. A 26-agent run
  metered as 0 agents / 28K, understating it by an order of magnitude and feeding
  a meaningless verdict. The meter now falls back to the newest Workflow run dir
  when the session read finds no agents (never both, so a build run is not
  double-counted), names each agent from its own first prompt line, and prints the
  `agent source:` it used. `--workflow <dir>` pins a specific run.

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
