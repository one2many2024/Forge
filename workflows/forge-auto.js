export const meta = {
  name: 'forge-ship',
  description: 'Autonomous forge arc: reuse-audit → plan → TDD → implement → scope → review battery → verify → resolve → gate → do-NOT-merge PR → gap-audit. No human breakpoints; merge and prod-migration apply stay human.',
  phases: [
    { title: 'Plan' },
    { title: 'Implement' },
    { title: 'Review' },
    { title: 'Verify' },
    { title: 'Resolve' },
    { title: 'Gate' },
    { title: 'Ship' },
    { title: 'Gap-audit' },
  ],
}

// ---------------------------------------------------------------------------
// Bounds. MAX_* are hard caps that apply REGARDLESS of budget (the real limit).
// A +budget only scales depth UP within these caps; with no budget you get the
// baseline defaults. MAX_BUDGET is a self-imposed output-token ceiling checked
// via budget.spent() — it bounds an unattended run even when the user set none.
// ---------------------------------------------------------------------------
const MAX_BUDGET = 750_000          // output-token self-cap (graceful degrade on hit)
const MAX_FINDER_ROUNDS = 5
const MAX_GATE_REPAIRS = 3
const MAX_VERIFY_VOTES = 5
const TOKENS_PER_ROUND = 150_000    // rough cost of one extra review round

// Budget-derived depth (guarded on budget.total — null ⇒ baseline).
const FINDER_ROUNDS = budget.total
  ? Math.min(MAX_FINDER_ROUNDS, Math.max(1, Math.floor(budget.total / TOKENS_PER_ROUND)))
  : 1
const VERIFY_VOTES = budget.total ? MAX_VERIFY_VOTES : 3

const task = (args && args.task) ? String(args.task) : null
const baseBranch = (args && args.baseBranch) ? String(args.baseBranch) : 'main'

// True once the run has spent its self-imposed ceiling — callers degrade, not throw.
const capped = () => budget.spent() >= MAX_BUDGET

// --- schemas (validated at the tool layer; agents must return these shapes) ---
const SCOPE_SCHEMA = {
  type: 'object',
  required: ['files', 'flags'],
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    flags: {
      type: 'object',
      required: ['TOUCHES_DB', 'TOUCHES_API', 'TOUCHES_AUTH', 'TOUCHES_PERF'],
      properties: {
        TOUCHES_DB: { type: 'boolean' },
        TOUCHES_API: { type: 'boolean' },
        TOUCHES_AUTH: { type: 'boolean' },
        TOUCHES_PERF: { type: 'boolean' },
      },
    },
  },
}
const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'file', 'line', 'summary'],
        properties: {
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          summary: { type: 'string' },
        },
      },
    },
  },
}
const VERDICT_SCHEMA = {
  type: 'object',
  required: ['real', 'reason'],
  properties: {
    real: { type: 'boolean' },
    reason: { type: 'string' },
  },
}
const GATE_SCHEMA = {
  type: 'object',
  required: ['green', 'summary'],
  properties: {
    green: { type: 'boolean' },
    summary: { type: 'string' },
  },
}

// Always-on lenses (trouble can come from anywhere) + flag-gated domain lenses.
const REVIEWERS = [
  { key: 'code-reviewer', gate: null },
  { key: 'security-reviewer', gate: null },
  { key: 'typescript-reviewer', gate: null },
  { key: 'silent-failure-hunter', gate: null },
  { key: 'refactor-cleaner', gate: null },
  { key: 'performance-optimizer', gate: 'perf' },
  { key: 'database-reviewer', gate: 'domain' },
]

async function run() {
  if (!task) {
    return { error: 'forge-ship: no task provided (args.task is empty).' }
  }

  // -- Plan -----------------------------------------------------------------
  phase('Plan')
  const plan = await agent(
    `You are the PLAN phase of an autonomous forge run. Task:\n\n${task}\n\n` +
    `Do a REUSE-AUDIT first (existing migrations, API routes, env vars, deps, imports — flag ` +
    `anything already on ${baseBranch}). Then produce a concrete implementation plan: files to ` +
    `touch, tests to write first (TDD), and any migration needed. Branch from ${baseBranch} as ` +
    `feat/… or fix/…. Return the plan as text.`,
    { phase: 'Plan', label: 'plan' },
  )

  // -- Implement (TDD-first) ------------------------------------------------
  phase('Implement')
  await agent(
    `Implement the task on a new branch off ${baseBranch}, TDD-first where a spec exists ` +
    `(author tests from the contract, confirm RED, implement to GREEN). Read before write; ` +
    `trace the runtime call path; scope edits to files on the live path. Write any migration ` +
    `additively (IF NOT EXISTS, no downtime) but DO NOT apply it to prod. Plan:\n\n${plan}`,
    { phase: 'Implement', label: 'implement' },
  )

  // -- Scope (real forge-scope.sh: changed-file set + TOUCHES_* flags) -------
  const scope = await agent(
    `Run \`bash scripts/forge-scope.sh ${baseBranch}\` (copy it from this plugin into the repo's ` +
    `scripts/ first if absent). Return its changed-file set and TOUCHES_* flags as booleans.`,
    { phase: 'Implement', label: 'scope', schema: SCOPE_SCHEMA },
  )
  const files = (scope && scope.files) ? scope.files : []
  const flags = (scope && scope.flags) ? scope.flags : {}
  const activeReviewers = REVIEWERS.filter((r) => {
    if (!r.gate) return true
    if (r.gate === 'perf') return !!flags.TOUCHES_PERF
    if (r.gate === 'domain') return !!(flags.TOUCHES_DB || flags.TOUCHES_API || flags.TOUCHES_AUTH)
    return true
  })
  const scopeLine = files.length ? files.join('\n') : '(scope empty — review the working diff)'

  // -- Review battery → per-finding adversarial verify (pipeline: verify as
  //    each lens completes). Looped up to FINDER_ROUNDS, budget-capped. -------
  phase('Review')
  const confirmed = []
  const seen = new Set()
  let round = 0
  let cappedEarly = false
  while (round < FINDER_ROUNDS) {
    round += 1
    if (capped()) { cappedEarly = true; break }

    const perLens = await pipeline(
      activeReviewers,
      (r) => agent(
        `${r.key}: review ONLY these changed files (never audit the repo):\n${scopeLine}\n\n` +
        `Round ${round}. Return compact findings — severity · file:line · one-line summary.`,
        { phase: 'Review', label: `review:${r.key}`, schema: FINDINGS_SCHEMA },
      ),
      (review) => parallel(
        ((review && review.findings) || []).map((f) => () =>
          // Perspective-diverse verify: N skeptics try to REFUTE; majority-real survives.
          parallel(
            Array.from({ length: VERIFY_VOTES }, (_, i) => () =>
              agent(
                `Adversarially verify this finding — try to REFUTE it with evidence (cite ` +
                `file:line). Default real=false if uncertain.\n${f.severity} ${f.file}:${f.line} ` +
                `— ${f.summary}\n(lens ${i + 1})`,
                { phase: 'Verify', label: `verify:${f.file}:${f.line}`, schema: VERDICT_SCHEMA },
              ),
            ),
          ).then((votes) => {
            const good = votes.filter(Boolean)
            const realCount = good.filter((v) => v.real).length
            return { ...f, real: realCount * 2 >= good.length } // majority-real
          }),
        ),
      ),
    )

    phase('Verify')
    const fresh = perLens.flat().filter(Boolean).filter((f) => f && f.real)
    let added = 0
    for (const f of fresh) {
      const k = `${f.file}:${f.line}:${f.summary}`
      if (seen.has(k)) continue
      seen.add(k)
      confirmed.push(f)
      added += 1
    }
    log(`round ${round}: +${added} confirmed (total ${confirmed.length}); spent ${Math.round(budget.spent() / 1000)}k`)
    if (added === 0) break // dry round — stop looping
  }

  // -- Resolve confirmed findings (CRITICAL/HIGH/MEDIUM must be fixed) -------
  phase('Resolve')
  const mustFix = confirmed.filter((f) => f.severity !== 'LOW')
  if (mustFix.length && !capped()) {
    await agent(
      `Resolve these verified findings — fix each, or justify it inline with a code comment. ` +
      `Do not "fix" non-bugs; do not weaken tests.\n` +
      mustFix.map((f) => `- ${f.severity} ${f.file}:${f.line} — ${f.summary}`).join('\n'),
      { phase: 'Resolve', label: 'resolve' },
    )
  }

  // -- Full gate through gate-summary; repair loop; HARD STOP if still red ---
  phase('Gate')
  let gate = { green: false, summary: 'not run' }
  let repairs = 0
  while (repairs <= MAX_GATE_REPAIRS) {
    gate = await agent(
      `Run the full gate through \`bash scripts/gate-summary.sh "<label>" "<command>"\` for each ` +
      `of: unit, lint, tsc (tsconfig.ci if present), build, e2e, and any Supabase/RALPH checks ` +
      `the repo has. Report only PASS/failing-excerpt per gate. Return green=true only if EVERY ` +
      `gate passed for real (a skip is NOT a pass).`,
      { phase: 'Gate', label: `gate:attempt-${repairs}`, schema: GATE_SCHEMA },
    )
    if (gate.green) break
    repairs += 1
    if (repairs > MAX_GATE_REPAIRS || capped()) break
    await agent(
      `The gate is RED. Root-cause and fix (including pre-existing failures — verify with ` +
      `git log ${baseBranch}..HEAD before blaming this change). Never weaken a test.\n${gate.summary}`,
      { phase: 'Gate', label: `gate:repair-${repairs}`, schema: GATE_SCHEMA },
    )
  }

  // -- Ship: commit, push named branch, open do-NOT-merge PR ----------------
  //    Green → normal PR. Red (repairs exhausted) → draft/failing PR + diagnosis.
  phase('Ship')
  const ship = await agent(
    `Commit per logical step and push the named branch (only that branch) off ${baseBranch}. ` +
    `Open a Pull Request marked "do NOT merge to main without review". ` +
    (gate.green
      ? `The gate is GREEN — open a normal PR.`
      : `The gate is RED after ${MAX_GATE_REPAIRS} repair attempts — open a DRAFT PR titled ` +
        `"[gate-red] …" with the failing-gate diagnosis in the body. Do NOT force it green.`) +
    ` Include a substantive PR body (inventory, decisions, gate results). If a migration exists, ` +
    `post the Supabase Migration Required comment (filenames + one-line each + "safe to run") ` +
    `and note it was NOT applied to prod (human-gated). Otherwise post "No Supabase action ` +
    `needed for this branch." Return the PR URL as text.`,
    { phase: 'Ship', label: 'ship' },
  )

  // -- Gap-audit against the original task's Definition of Done -------------
  phase('Gap-audit')
  const gapAudit = await agent(
    `Re-read the original task and audit item-by-item, labeling each: ✅ done & verified / ` +
    `⚠️ consciously omitted (with reason) / ⛔ genuinely open / 🧹 housekeeping. Be honest — ` +
    `only claim what passed its gate.\n\nTASK:\n${task}\n\nCONFIRMED FINDINGS RESOLVED: ` +
    `${mustFix.length}\nGATE GREEN: ${gate.green}\nPR: ${ship}`,
    { phase: 'Gap-audit', label: 'gap-audit' },
  )

  return {
    prUrl: ship,
    gateGreen: gate.green,
    gateSummary: gate.summary,
    confirmedFindings: confirmed.length,
    mustFixResolved: mustFix.length,
    reviewRounds: round,
    tokensSpent: budget.spent(),
    cappedAtMaxBudget: cappedEarly || capped(),
    gapAudit,
  }
}

return await run()
