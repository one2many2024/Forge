# Skipped gates — feat/evidence-pr (Forge 0.6.0)

Forge is a Claude Code plugin: Markdown commands, a Workflow script and dependency-free Node
helpers. It has no Next.js app, no database, no browser UI and no build step. The one suite that
exists, `npm test` (`node --test`), was run in full. A skip is not a pass; each entry below says
why the suite cannot run here and what would change that.

| Suite | Command | Why it is skipped | How to unblock |
|---|---|---|---|
| Build | — (no `build` script) | Nothing is compiled or bundled; the plugin ships its sources as-is. | Add a `build` script if Forge ever gains a compile step. |
| Lint | — (no `lint` script, no ESLint config) | The repo has no linter configured. | Add ESLint (or Biome) and a `lint` script. |
| TypeCheck | — (no `tsconfig.json`) | Plain JavaScript, no TypeScript. | Add `// @ts-check` + a `tsconfig.json` with `checkJs` and a `typecheck` script. |
| RALPH loop | — (no RALPH spec-lock suite) | Forge has no AI-router surface or RALPH specs. | Not applicable unless such specs are added. |
| Supabase | — (`check:schema-drift` / `check:rls-predicates` / `check:anon-write-grants` absent) | No database, no migrations. | Not applicable. |
| E2E | — (no E2E suite) | No running app to drive. | Not applicable. |
| Playwright | — (no `playwright.config.ts`, no `@playwright/test`) | No browser UI. The evidence script's Jest, Vitest and Playwright paths are tested against stand-in runner packages (bin resolution, argv, name filter, pass/fail parsing), not real installs. | Add fixture repos with the real runners installed if a runner's output format needs end-to-end coverage. |

## Open items
- [ ] CI is not configured on this repository (no `.github/workflows/`), so no check runs exist for the PR head commit and the Evidence section reports ⛔. Add a workflow that runs `npm test` on pull requests.
