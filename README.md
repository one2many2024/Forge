# Forge

**One command that ships a feature end to end — with the discipline baked in.**

`/forge "<your task>"` runs a two-step orchestration arc on top of the
[babysitter](https://github.com/a5c-ai/babysitter) run engine:

1. **PLAN** — a reuse-audit, then a written, reviewable execution plan (nothing is built yet).
2. **EXECUTE** — drives the plan to a pull request with a parallel review battery, test-driven
   development, the full quality gate, and human approval breakpoints.
3. **GAP-AUDIT** — closes by telling you, honestly, *what (if anything) was left out*.

It's the difference between "write me a feature" and "plan it, build it test-first, review it
from six angles, gate it, open a do-NOT-merge PR, and tell me what's still open."

---

## What the arc does

### Phase A — PLAN (pauses for your approval)
- **Phase 0 reuse-audit** — scans existing migrations, routes, env vars, dependencies, and
  imports so the plan *extends* what's there instead of duplicating it, and flags where the
  task's stated assumptions are wrong.
- Picks a **process shape** (flat phase-list for well-defined work; a hypotheses tree when the
  first step is "investigate").
- Authors a babysitter **process** with drift-resistant prompts (specs read at run time, not
  paraphrased) and tests ordered *before* implementation.
- Presents the plan, asks any real decisions, and **stops for your go-ahead**.

### Phase B — EXECUTE (after approval)
- Read-before-write; traces the runtime call path for brownfield changes.
- **Test-driven**: author from the contract, confirm RED, implement to GREEN.
- **Parallel pre-commit review battery** — `code-reviewer`, `security-reviewer`,
  `typescript-reviewer`, `performance-optimizer`, `refactor-cleaner`, `silent-failure-hunter`
  (plus DB/RLS/API-security lenses when relevant). Every CRITICAL/HIGH/MEDIUM is resolved;
  false positives are refuted with evidence.
- **Human breakpoints** at the design gate and final sign-off (never auto-approved).
- **Full gate** (fix failures — including pre-existing — before proceeding): unit → build →
  lint → typecheck → E2E → any DB/security checks → spec-lock suites. A skip is not a pass.
- Commits per step, pushes the named branch only, opens a **do-NOT-merge** PR with a
  substantive body and the appropriate migration comment.

### Phase C — GAP-AUDIT
Re-reads your task's definition of done and reports each item as ✅ done · ⚠️ consciously
omitted (with justification) · ⛔ genuinely open · 🧹 housekeeping — plus the PR link.

---

## Bundled review agents

Forge ships its six review agents so the battery works on a fresh install (not just on the
author's machine): `code-reviewer`, `security-reviewer`, `typescript-reviewer`,
`performance-optimizer`, `refactor-cleaner`, `silent-failure-hunter`. Each returns a
`{ satisfied, findings[], summary }` verdict the arc consumes. If you already have your own
agent with one of these names, yours takes precedence; if a named agent is missing, the arc
falls back to a general-purpose agent with the same review lens — it never skips a review.

---

## Requirements

- **[Claude Code](https://claude.com/claude-code)**.
- **[babysitter](https://github.com/a5c-ai/babysitter)** — the run engine Forge orchestrates.
  It's installed as step 1 of the flow below (Forge also preflights for it and tells you how to
  install if it's missing).

## Install

```bash
# 1. Prerequisite — the orchestration engine
claude plugin marketplace add a5c-ai/babysitter
claude plugin install --scope user babysitter@a5c.ai

# 2. Forge
claude plugin marketplace add one2many2024/Forge
claude plugin install --scope user forge@forge
```

Restart Claude Code, then:

```
/forge "Add a GET /api/health route returning { status: 'ok', ts }, with a unit test. Branch feat/health-endpoint."
```

Forge will produce a plan, pause for your approval, execute it through the gate, open a
do-NOT-merge PR, and finish with the gap-audit.

## Usage notes

- The task prompt is free-form — include ground truth, constraints, branch name, and the
  definition of done; the richer the prompt, the tighter the arc.
- Forge **never merges** — it opens the PR for you to review and merge.
- It pauses twice (plan approval, final sign-off) and at any design gate the process defines;
  you can approve in a word.

## License

MIT © 2026 Eli Gur. See [LICENSE](./LICENSE).

Forge orchestrates, and depends on, the separate **babysitter** plugin, which has its own
authors and license.
