---
description: "Explains the forge commands — build (interactive) and ship (autonomous): what they do, arguments, and when to use each."
argument-hint: "(no arguments)"
---

# /forge:help — how to use forge

Print the guide below to the user verbatim (fill in nothing — it is static help). Do not run
any task; if the user included a task prompt, tell them to pass it to `/forge:build` or
`/forge:ship` instead.

---

**Forge** runs our full feature arc — reuse-audit → plan → TDD → implement → parallel review
battery → gate → do-NOT-merge PR → gap-audit — in one command. It ships in two modes:

## `/forge:build "<task>"` — interactive (guided)
- **What:** the arc on **babysitter's run lifecycle**, pausing at **two human breakpoints** —
  a design-gate after the core design, and a final sign-off before commit/PR.
- **Use when:** the task is non-trivial, ambiguous, or you want to steer the design before it
  builds. This is the default for most work.
- **Args:** `"<the full task / instructions prompt>"` (quoted). No budget flag.
- **You will be asked:** to approve the plan, then to sign off before the PR is opened.

## `/forge:ship "<task>" [+<budget>]` — autonomous (hands-off)
- **What:** the same arc with **no pauses**, driven by a deterministic **Workflow engine**.
  Runs start-to-finish and opens a do-NOT-merge PR on its own, then reports back.
- **Use when:** the task is well-scoped and you want to walk away and review the PR.
- **Args:**
  - `"<task prompt>"` (quoted) — required.
  - `+<budget>` (optional, e.g. `+800k`) — a token target that lets ship look **harder**
    (more finder rounds, deeper adversarial verify, wider fan-out). Omit it for a
    **baseline** run — ship still completes the whole arc, just at default depth.
- **Self-cap:** ship stops at **750k output tokens** regardless of budget; on the cap it opens
  the PR with what it has and says so.

## What stays human in BOTH modes (never automated)
- **Merge to `main`** — always requires human review. Forge only ever opens a do-NOT-merge PR.
- **Applying a migration to prod** — forge writes the migration into the PR; a human applies it.
- **A red gate is never bypassed** — no weakened tests, no skips-as-pass. A failing gate stops
  the run (build asks you; ship opens a failing/draft PR with the diagnosis).

## The commands
| Command | Mode | Pauses? | Budget flag |
|---|---|---|---|
| `/forge:build "<task>"` | interactive | design-gate + sign-off | — |
| `/forge:ship "<task>" [+budget]` | autonomous | none | optional `+<budget>` |
| `/forge:help` | — | — | — |

## Prerequisite
`build` needs the **babysitter** plugin (`claude plugin install --scope user
babysitter@a5c.ai`, then restart). `ship` needs the `Workflow` tool available in the session.

## After any repo change to forge itself
Bump `.claude-plugin/plugin.json` `version`, or `claude plugin update` silently no-ops
(it compares semver, not commit SHA). Then `claude plugin marketplace update forge` →
`claude plugin update forge@forge` → **restart**.
