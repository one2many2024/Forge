# Forge

**One command that ships a feature end to end — with the discipline baked in.**

Forge runs a full feature arc — reuse-audit → plan → test-driven implementation → parallel
review battery → full quality gate → do-NOT-merge PR → gap-audit → run-summary — on top of the
[babysitter](https://github.com/a5c-ai/babysitter) run engine. It comes in two modes:

- **`/forge:build "<task>"`** — *interactive*. Drives the arc on babysitter's run lifecycle and
  **pauses at two human breakpoints** (a design-gate, then a final sign-off). The default for
  most work.
- **`/forge:ship "<task>" [+budget]`** — *autonomous*. The same arc with **no pauses**, driven by
  a deterministic **Workflow engine**; runs start-to-finish, opens the PR, and reports back.

It's the difference between "write me a feature" and "plan it, build it test-first, review it
from six angles, gate it, open a do-NOT-merge PR, and tell me what's still open and what it cost."

> **Command names:** Claude Code namespaces every plugin command by its plugin, so the commands
> are `/forge:build`, `/forge:ship`, and `/forge:help` (just as babysitter's is
> `/babysitter:plan`). A bare `/forge` does **not** resolve.

---

## The commands

| Command | Mode | Pauses? | Engine | Budget flag |
|---|---|---|---|---|
| `/forge:build "<task>"` | interactive | design-gate + sign-off | babysitter run lifecycle | — |
| `/forge:ship "<task>" [+budget]` | autonomous | none | Workflow engine (`workflows/forge-auto.js`) | optional `+<budget>` (e.g. `+800k`) |
| `/forge:help` | — | — | — | — |

Use **build** when the task is non-trivial, ambiguous, or you want to steer the design before it
builds. Use **ship** when it's well-scoped and you want to walk away and review the finished PR.

---

## What the arc does

### Phase A — PLAN
- **Phase 0 reuse-audit** — scans existing migrations, routes, env vars, dependencies, and
  imports so the plan *extends* what's there instead of duplicating it, and flags where the
  task's stated assumptions are wrong.
- Picks a **process shape** (flat phase-list for well-defined work; a hypotheses tree when the
  first step is "investigate").
- Authors the work with **drift-resistant prompts** (specs read at run time, not paraphrased) and
  tests ordered *before* implementation.
- **build** presents the plan and **stops for your go-ahead**; **ship** proceeds automatically.

### Phase B — EXECUTE
- Read-before-write; traces the runtime call path for brownfield changes.
- **Test-driven**: author from the contract, confirm RED, implement to GREEN.
- **Token-conscious parallel pre-commit review battery** — scoped to the changed-file set via
  `scripts/forge-scope.sh`. Always runs `code-reviewer`, `security-reviewer`, `typescript-reviewer`,
  `silent-failure-hunter`, `refactor-cleaner`; adds `performance-optimizer` + DB/RLS/API-security
  lenses only when the touched files warrant it. Every CRITICAL/HIGH/MEDIUM is resolved; false
  positives are refuted with evidence.
- **build** pauses at the design-gate and final sign-off (never auto-approved); **ship** does not.
- **Full gate** (fix failures — including pre-existing — before proceeding): unit → build → lint →
  typecheck → E2E → any DB/security checks → spec-lock suites, each summarised to pass /
  failing-excerpt via `scripts/gate-summary.sh`. A skip is not a pass.
- Commits per step, pushes the named branch only, opens a **do-NOT-merge** PR with a substantive
  body and the appropriate migration comment.

### Phase C — GAP-AUDIT
Re-reads your task's definition of done and reports each item as ✅ done · ⚠️ consciously omitted
(with justification) · ⛔ genuinely open · 🧹 housekeeping — plus the PR link.

### Phase D — RUN SUMMARY
Closes every run (build *and* ship) with one compact, fixed-format block via
`scripts/forge-summary.mjs` — not a hand-written recap:
- a **per-phase / per-step token table** (Recon / Design / Tests / Implementation / Review
  battery / Resolve / …), one row per agent, plus an **Orchestration (main-loop)** row and a **TOTAL**;
- a **rule-based verdict** — 🟢 defensible / 🟡 heavy-justify / 🔴 runaway — from agent-count ÷
  changed-files (and the budget, for ship), so a runaway is flagged automatically, not by feel;
- the **`## Open items`** parsed from `SKIPPED.md`, with a 🆕 on anything added this run.

The numbers come from the Claude Code **session transcript** — the on-disk record of per-turn
`usage` for the orchestration loop and every subagent's reported `subagent_tokens`. Output tokens
are the headline. Record open/owner-action items under a `## Open items` heading with `- [ ]`
checkboxes so the meter can list them.

> **⚠️ Accuracy disclaimer — please read.** The run-summary's token counts, timing, totals, and
> verdict are derived from the session transcript on a **best-effort basis** and are provided
> **"as true and accurate as we could measure."** They are approximations that may be affected by
> transcript-format changes, un-instrumented or background work, retries, prompt caching, rounding,
> or measurement gaps, and are intended for **relative, informational guidance only** — *not* for
> billing, cost accounting, or any authoritative accounting of usage. Forge and its authors make
> **no warranty** as to their accuracy and accept **no liability** for any decision made in reliance
> on them. Your AI provider's own usage and billing records are the sole source of truth.

---

## What stays human — in both modes (never automated)

- **Merge to `main`** — always requires human review. Forge only ever opens a do-NOT-merge PR.
- **Applying a migration to prod** — forge writes the migration into the PR; a human applies it.
- **A red gate is never bypassed** — no weakened tests, no skips-as-pass. A failing gate stops the
  run (build asks you; ship opens a failing/draft PR with the diagnosis).

## Ship: budget, depth, and self-caps

Autonomy removes *pauses*, not *safeguards*. `/forge:ship`:
- takes an optional **`+<budget>`** token target (e.g. `+800k`) that lets it look harder — more
  finder rounds, deeper adversarial verify, wider fan-out. Omit it for a **baseline** run.
- enforces **hard ceilings before every agent spawn**: a **750k output-token cap** (`budget.spent()`)
  and a budget-scaled **agent-count cap**. On either it aborts to the PR step, opens the PR with
  what it has, and reports the cap reason — never a silent runaway.
- **scales depth to the diff**: a trivial (comment/doc/config) change uses a minimal reviewer set,
  skips build/e2e, and skips deep verify. The gate runs a FAST loop (lint/tsc/unit, source-only
  repairs that never edit tests) and a SLOW pass (build/e2e) **at most once, never in a loop**.

> Wall-clock isn't enforceable inside the engine (its runtime forbids `Date`). Watch `/workflows`
> and `TaskStop` a run that stalls.

---

## Bundled review agents

Forge ships its six review agents so the battery works on a fresh install: `code-reviewer`,
`security-reviewer`, `typescript-reviewer`, `performance-optimizer`, `refactor-cleaner`,
`silent-failure-hunter`. Each returns a `{ satisfied, findings[], summary }` verdict the arc
consumes. If you already have your own agent with one of these names, yours takes precedence; if a
named agent is missing, the arc falls back to a general-purpose agent with the same review lens —
it never skips a review.

## Helper scripts

Portable, dependency-free scripts the arc copies into the target repo's `scripts/` (build) or runs
from the plugin (ship):

- **`forge-scope.sh`** — computes the changed-file set + `TOUCHES_DB/API/AUTH/PERF` flags that scope
  the review battery and gate its conditional lenses.
- **`gate-summary.sh`** — runs a gate and emits only `PASS` or the exit code + failing lines, so
  green logs never flood context.
- **`forge-summary.mjs`** — the Phase D run-summary / token meter (Node; reads the session transcript).

---

## Requirements

- **[Claude Code](https://claude.com/claude-code)**.
- **`/forge:build`** needs **[babysitter](https://github.com/a5c-ai/babysitter)** — the run engine
  it orchestrates (installed in step 1 below; Forge also preflights for it).
- **`/forge:ship`** needs the **`Workflow` tool** available in the session. If it isn't, ship tells
  you and offers `/forge:build` as the interactive fallback.

## Install

```bash
# 1. Prerequisite for /forge:build — the orchestration engine
claude plugin marketplace add a5c-ai/babysitter
claude plugin install --scope user babysitter@a5c.ai

# 2. Forge
claude plugin marketplace add one2many2024/Forge
claude plugin install --scope user forge@forge
```

Restart Claude Code, then:

```
/forge:build "Add a GET /api/health route returning { status: 'ok', ts }, with a unit test. Branch feat/health-endpoint."
```

Forge produces a plan, pauses for your approval (build), executes it through the gate, opens a
do-NOT-merge PR, and finishes with the gap-audit + run-summary.

## Usage notes

- The task prompt is free-form — include ground truth, constraints, branch name, and the definition
  of done; the richer the prompt, the tighter the arc.
- Forge **never merges** — it opens the PR for you to review and merge.
- `build` pauses twice (plan approval, final sign-off) plus at any design gate the process defines;
  you can approve in a word. `ship` runs unattended — watch `/workflows` if you want to observe it.
- `/forge:help` prints the mode guide any time.

## Updating forge itself

After any change to the Forge repo, **bump `.claude-plugin/plugin.json` `version`** — `claude plugin
update` compares semver, not commit SHA, so without a bump it silently no-ops on every machine.
Then: `claude plugin marketplace update forge` → `claude plugin update forge@forge` → **restart**.

## License

MIT © 2026 Eli Gur. See [LICENSE](./LICENSE).

Forge orchestrates, and depends on, the separate **babysitter** plugin, which has its own authors
and license.
