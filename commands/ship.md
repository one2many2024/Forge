---
description: "Autonomous feature arc — runs start-to-finish with NO human breakpoints, driving a Workflow engine, and opens a do-NOT-merge PR. Merge and prod-migration apply stay human."
argument-hint: "\"<the full task / instructions prompt>\"   [+<budget>]"
---

# /forge:ship — the autonomous, hands-off arc

You are running **FORGE ship** (full-auto mode) on the task in the arguments below. Unlike
`/forge:build`, ship has **no human breakpoints** — it runs the whole arc to a finished
do-NOT-merge PR without pausing. It does this by driving a deterministic **Workflow engine**
(`workflows/forge-auto.js`), not by improvising the arc turn-by-turn. For the guided variant
with design-gate + sign-off pauses, use `/forge:build`. For usage help, `/forge:help`.

**THE TASK / INSTRUCTIONS PROMPT (may end with a `+<budget>` token target, e.g. `+800k`):**

> $ARGUMENTS

If the task portion is empty, ask the user for the task prompt and stop.

---

## What ship does (and does NOT do)

- **Opt-in authorized.** This command's instructions explicitly authorize the `Workflow` tool.
  Invoke the `Workflow` tool with `{ scriptPath: "<this plugin>/workflows/forge-auto.js",
  args: { task: "<the task prompt>", baseBranch: "main" } }`. Parse a trailing `+<budget>`
  (e.g. `+800k`) off the arguments and surface it to the user as the turn's token target; the
  Workflow reads it via its `budget` global. If no `+budget` is given, ship runs at **baseline
  depth** (see the engine's defaults) — it still completes the full arc.
- **Runs unattended to a PR.** The Workflow performs: reuse-audit → plan → TDD tests →
  implement → scope → parallel review battery → adversarial verify → resolve → full gate →
  commit → push → **do-NOT-merge PR** → gap-audit, then returns a structured report.
- **After it returns**, surface to the user: the **PR link**, the **gap-audit** table
  (done / consciously-omitted / open / housekeeping), the **gate status**, and the run's
  **token spend** (`budget.spent()` from the report) — plus whether it **hit the 750k cap**.

## Hard rails (non-negotiable in auto mode — autonomy removes PAUSES, not SAFEGUARDS)

1. **Never merge.** The PR is opened marked "do NOT merge … without review". A human merges.
2. **Gate is a hard stop.** If the full gate cannot go green within the engine's repair budget,
   ship **stops and opens a draft / failing PR with the diagnosis** — it never weakens a test,
   never force-commits red, never marks a skip as a pass.
3. **Prod-migration apply stays human.** Ship *writes* migrations and includes them in the PR,
   but does **NOT** apply them to prod. Prod migration application is human-gated, like merge.
4. **Token ceiling.** The engine self-caps at **`MAX_BUDGET = 750_000`** output tokens
   (`budget.spent()`). On reaching it, ship degrades gracefully — finishes the current phase,
   opens the PR with what it has, and reports "capped at MAX_BUDGET, depth reduced". Never a
   silent truncation.
5. **Same repo conventions as build** — branch from `main`, push only the named branch,
   migration comment on the PR, Windows/PowerShell host rules, graceful degradation when a
   repo gate (Supabase checks, RALPH, tsconfig.ci) is absent.

## If the Workflow tool is unavailable

If invoking the `Workflow` tool is not possible in this environment, tell the user ship
requires it and offer `/forge:build` (which runs on babysitter) as the interactive fallback.
Do NOT silently hand-roll the autonomous arc without the engine.
