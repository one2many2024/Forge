---
description: End-to-end feature arc — babysitter PLAN then EXECUTE with full orchestration, closing with an "anything left out?" gap-audit.
argument-hint: "\"<the full task / instructions prompt>\""
---

# /forge:forge — the two-step orchestration arc

You are running the **FORGE arc** on the task described in the arguments below. Forge
wraps our standard two phases — `/babysitter:plan` then `/babysitter:call` — and applies
the same orchestration arc in BOTH, then finishes by telling the user what (if anything)
was left out.

**THE TASK / INSTRUCTIONS PROMPT:**

> $ARGUMENTS

If the arguments are empty, ask the user for the task prompt and stop.

**Preflight (do this first).** Confirm the **babysitter** skill is available (it powers both
phases). If `babysitter:babysit` is not installed, tell the user to install it and stop:
`claude plugin marketplace add a5c-ai/babysitter` then
`claude plugin install --scope user babysitter@a5c.ai` (restart, then re-run `/forge:forge`).

---

## Non-negotiables (apply throughout both phases)

- **Use the babysitter SDK/run lifecycle** for orchestration — create a process + run and
  drive `run:iterate → perform effects → task:post` in-turn to the completion proof. Do not
  hand-roll the work outside the run journal.
- **Branch from `main`** (rebased/up to date), named per the task or `feat/…`/`fix/…`;
  never `git push --all` — push only the named branch. Commit per logical step.
- **Never merge the PR.** Open it marked "do NOT merge … without review". Eli merges.
- **Migration comment standard:** after opening the PR, post either the ⚠️ **Supabase
  Migration Required** comment (each filename + one-line description + "safe to run"
  confirmation) or **"No Supabase action needed for this branch."**
- **A skip is not a pass.** Run every gate for real where creds exist; otherwise record it
  in `SKIPPED.md` with the exact command, why it's blocked, and how to unblock — last resort,
  not an exit ramp.
- **Windows/PowerShell host:** prefer PowerShell for system ops; never write inline compound
  shell chains (`&`, `;`, `$(...)`) — put multi-step shell work in a `scripts/` file.
- **Never fabricate a breakpoint approval.** In interactive mode, always ask the user and
  pass through their actual selection.
- This command is user-global: if the repo lacks a given gate (Supabase checks, RALPH,
  tsconfig.ci), degrade gracefully — run what exists, note what doesn't.

---

## PHASE A — PLAN (plan-only; do NOT create the run yet)

Invoke the **babysitter:babysit** skill (Skill tool) in plan-only mode for this task, and:

1. **Phase 0 — REUSE-AUDIT (mandatory, before authoring anything).** Extract the keyword
   nouns/verbs from the prompt and scan for pre-existing infrastructure to reuse or extend:
   migrations, API routes, env vars, SDK deps, and imports (honor `.a5c/reuse-audit.json`
   if present). Render a **"Reuse-audit findings (REVIEW BEFORE PROCEEDING)"** block, and
   explicitly flag any place where the prompt's stated ground truth is wrong (e.g. "these
   files are already on main"). If the audit changes the plan, say so.
2. **Pick the process shape:** flat phase-list when the first phase is "implement X" and the
   work is well-defined; a HYPOTHESES tree when the first phase is "investigate" (unknown
   bug class, competing causal models).
3. **Author the process** (`.a5c/processes/<name>.js` + `.process.md` + `.mermaid.md` +
   `.inputs.json`) using the repo's process idioms. Encode the verified ground truth as
   constants. Use **drift-resistant prompts**: read spec/artifact bytes at run time via a
   shell `cat` and interpolate verbatim — never paraphrase a spec into a prompt literal.
   Order any test-authoring phase BEFORE its implementation phase so tests are frozen inputs.
   Use `kind: 'shell'` for deterministic gates (tsc/lint/tests/grep) and `kind: 'agent'`/
   `'skill'` for reasoning/review; never `kind: 'node'`.
4. **Bake the arc into the process:** read-before-write; TDD-first where a spec exists; a
   parallel pre-commit review battery; a human design-gate breakpoint after the core design;
   the full gate; a final sign-off breakpoint; commit/push/PR-never-merge + migration comment.
5. **Present** the plan at a high level with the reuse-audit block, then use **AskUserQuestion**
   for any genuine decisions (design choices, scope, the daily-cap/threshold-style constants).
   **Then PAUSE and ask the user to approve the plan before executing.** Do not create the run.

---

## PHASE B — EXECUTE (only after the user approves the plan)

Create the run (`run:create … --harness claude-code`) and drive the loop in-turn to the
completion proof, applying the arc at every phase:

- **Read before write; trace the runtime call path** for brownfield changes and scope edits
  to files actually on the live path (grep the whole `src/`, not just entry dirs).
- **TDD-first** where a spec exists: author tests from the contract (not the impl), confirm
  RED, then implement to GREEN.
- **Mandatory parallel pre-commit review battery** the moment implementation is complete —
  launch simultaneously: `code-reviewer`, `security-reviewer`, `typescript-reviewer`,
  `performance-optimizer`, `refactor-cleaner`, `silent-failure-hunter`, and — when DB / API /
  auth / PII are touched — `database-reviewer` + the RLS / API-security audit checklists.
  Resolve **every CRITICAL / HIGH / MEDIUM** (fix it, or justify in a code comment) before
  committing. **Adversarially verify** findings and refute false positives with evidence
  (cite file:line) rather than "fixing" non-bugs. If a named reviewer agent isn't installed,
  fall back to `general-purpose` with the same review lens — never skip the review.
- **Human breakpoints** (never auto-approve; SendUserFile any composites/artifacts to review):
  a **design gate** after the core design/migration, and a **final sign-off** before commit/PR.
- **Full gate — fix failures (including pre-existing) before proceeding, never weaken a test:**
  unit → build → lint → typecheck (`tsc --noEmit -p tsconfig.ci.json` if present) → E2E →
  Supabase checks (`check:schema-drift` / `check:rls-predicates` / `check:anon-write-grants`
  if present) → RALPH spec-lock suite (runs inside the unit run). Register any new Playwright
  spec in `playwright.config.ts` or it silently never runs. Root-cause pre-existing failures
  (verify with `git log <base>..<head>` before blaming your change); a `page.route()` mock
  never intercepts a server component's direct DB read — control the DB row instead.
- **Migrations:** additive / `IF NOT EXISTS` / no downtime; verify RLS deny-by-default,
  least-privilege grants, and atomicity; apply to prod only when the user directs it or repo
  convention requires; then `gen:types`, remove any temporary `.rpc` cast, and run the
  env-gated live-boundary tests (local `supabase start`, never the prod project for
  write-bearing specs).
- **Commit per step, push the named branch only, open the do-NOT-merge PR** with a
  substantive body (inventory/rationale tables, decisions, gate results) + the migration
  comment.
- If the run dead-ends or an effect keeps failing for a bad reason, **repair the process
  file / journal** and continue — don't replay a broken iteration.

---

## PHASE C — CLOSING GAP-AUDIT ("anything left out?")

Before declaring done, re-read the original task prompt's **Definition of Done / requirements
list** and go through it item by item. Report back to the user, honestly labeling each:

- ✅ **Done & verified** — with the evidence (counts, PR #, gate results).
- ⚠️ **Consciously omitted** — with the justification (e.g. "RALPH plugin wrapper not run as a
  separate step; the RALPH spec-lock suite ran inside `npm test` and a static change touches no
  AI-router surface").
- ⛔ **Genuinely open** — anything blocked (in `SKIPPED.md`) or owner-action (billing toggles).
- 🧹 **Housekeeping** — branch state, untracked run/process artifacts, running dev servers,
  local stacks — and offer to clean them up.

End with the PR link(s) and the one-line status. Only claim completion for work that actually
passed its gate; if something failed or was skipped, say so plainly.
