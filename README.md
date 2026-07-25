# Forge

**One plugin that ships a feature end to end — with the discipline baked in.**

Forge runs a full feature arc on top of the [babysitter](https://github.com/a5c-ai/babysitter)
run engine — reuse-audit → plan → TDD → implement → parallel review battery → gate →
do-NOT-merge PR → gap-audit — in two modes:

1. **`/forge:build "<task>"`** — interactive. Pauses at two human breakpoints: a design-gate
   after the core design, and a final sign-off before commit/PR. The default for most work.
2. **`/forge:ship "<task>" [+<budget>]`** — autonomous. No pauses; runs start-to-finish on a
   deterministic Workflow engine and opens a do-NOT-merge PR on its own, then reports back.
3. **`/forge:help`** — prints the full usage guide, including which mode to use when.

It's the difference between "write me a feature" and "plan it, build it test-first, review it
from six angles, gate it, open a do-NOT-merge PR, and tell me what's still open."

---

## The two modes

### `/forge:build "<task>"` — guided

- **Phase 0 reuse-audit** — scans existing migrations, routes, env vars, dependencies, and
  imports so the plan *extends* what's there instead of duplicating it, and flags where the
  task's stated assumptions are wrong.
- Authors a babysitter **process** with drift-resistant prompts (specs read at run time, not
  paraphrased) and tests ordered *before* implementation.
- **Presents the plan and pauses for your approval.** Nothing is built yet.
- After approval: read-before-write, **test-driven** (author from the contract, confirm RED,
  implement to GREEN), then the **parallel pre-commit review battery** — `code-reviewer`,
  `security-reviewer`, `typescript-reviewer`, `performance-optimizer`, `refactor-cleaner`,
  `silent-failure-hunter` (plus DB/RLS/API-security lenses when relevant). Every
  CRITICAL/HIGH/MEDIUM is resolved; false positives are refuted with evidence.
- **Human breakpoints** at the design gate and final sign-off (never auto-approved).
- **Full gate** (fix failures — including pre-existing — before proceeding): unit → build →
  lint → typecheck → E2E → any DB/security checks → spec-lock suites. A skip is not a pass.
- Commits per step, pushes the named branch only, opens a **do-NOT-merge** PR with a
  substantive body and the appropriate migration comment.

### `/forge:ship "<task>" [+<budget>]` — autonomous

- Same arc, **no human breakpoints**, driven by a deterministic **Workflow engine**
  (`workflows/forge-auto.js`) rather than improvised turn-by-turn.
- **Its own trust mechanism in place of the pauses:** CRITICAL/HIGH findings need 2–3
  independent adversarial "try to refute this" votes before they count as real; MEDIUM gets
  one vote; LOW isn't verified.
- **Hard ceilings that fire mid-flight**, checked before every agent spawn — a token-budget
  cap (750k output tokens by default, wider with an optional `+<budget>` flag) and a
  budget-scaled agent-count cap. Hitting either aborts to the ship step and opens the PR with
  what it has, reporting the cap reason — never a silent truncation or a runaway.
- **Depth scales to the diff** — a trivial (comment/doc/config-only) change uses a minimal
  reviewer set and skips build/e2e and deep verify.
- Gate runs a bounded FAST repair loop (lint/tsc/unit, source-only fixes, never edits tests)
  and a SLOW pass (build/e2e) **at most once, never in a loop**.
- Same rails as `build`: never merges, writes but never applies a prod migration, pushes only
  the named branch, same migration-comment convention.

### Phase C — GAP-AUDIT (both modes)

Re-reads your task's definition of done and reports each item as ✅ done · ⚠️ consciously
omitted (with justification) · ⛔ genuinely open · 🧹 housekeeping — plus the PR link. Only
claims completion for work that actually passed its gate.

---

## What stays human in both modes (never automated)

- **Merge to `main`** — always requires human review. Forge only ever opens a do-NOT-merge PR.
- **Applying a migration to prod** — Forge writes the migration into the PR; a human applies it.
- **A red gate is never bypassed** — no weakened tests, no skips-as-pass. `build` asks you;
  `ship` opens a failing/draft PR with the diagnosis.

---

## Bundled review agents

Forge ships its six review agents so the battery works on a fresh install (not just on the
author's machine): `code-reviewer`, `security-reviewer`, `typescript-reviewer`,
`performance-optimizer`, `refactor-cleaner`, `silent-failure-hunter`. Each returns a
`{ satisfied, findings[], summary }` verdict the arc consumes. If you already have your own
agent with one of these names, yours takes precedence; if a named agent is missing, the arc
falls back to a general-purpose agent with the same review lens — it never skips a review.

Also included: `scripts/forge-scope.sh` (deterministic changed-file set + `TOUCHES_*` flags
that gate which domain specialists get spawned) and `scripts/gate-summary.sh` (runs a gate
command and emits only its verdict — one line on pass, only the failing excerpt on fail — so
kilobytes of green log never enter context).

---

## Requirements

- **[Claude Code](https://claude.com/claude-code)**.
- **[babysitter](https://github.com/a5c-ai/babysitter)** — the run engine `build` orchestrates.
  It's installed as step 1 of the flow below (Forge also preflights for it and tells you how to
  install if it's missing). `ship` additionally needs the `Workflow` tool available in the
  session.

## Install

```bash
# 1. Prerequisite — the orchestration engine
claude plugin marketplace add a5c-ai/babysitter
claude plugin install --scope user babysitter@a5c.ai

# 2. Forge
claude plugin marketplace add one2many2024/Forge
claude plugin install --scope user forge@forge
```

Restart Claude Code, then either:

```
/forge:build "Add a GET /api/health route returning { status: 'ok', ts }, with a unit test. Branch feat/health-endpoint."
```

or, for a well-scoped task you want to hand off entirely:

```
/forge:ship "Add a GET /api/health route returning { status: 'ok', ts }, with a unit test. Branch feat/health-endpoint."
```

Run `/forge:help` any time for the full guide to both modes.

> **Command names:** Claude Code namespaces every plugin command by its plugin, so the
> commands are `/forge:build`, `/forge:ship`, and `/forge:help` (just as babysitter's is
> `/babysitter:plan`). A bare `/forge` will not resolve.

## Usage notes

- The task prompt is free-form — include ground truth, constraints, branch name, and the
  definition of done; the richer the prompt, the tighter the arc.
- Forge **never merges** — it opens the PR for you to review and merge.
- `build` pauses twice (plan approval, final sign-off) and at any design gate the process
  defines; you can approve in a word. `ship` runs straight through instead.

## License

MIT © 2026 Eli Gur. See [LICENSE](./LICENSE).

Forge orchestrates, and depends on, the separate **babysitter** plugin, which has its own
authors and license.
