export const meta = {
  name: 'forge-ship',
  description: 'Autonomous forge arc: reuse-audit → plan → TDD → implement → scope → review battery → verify → resolve → gate → do-NOT-merge PR → gap-audit. No human breakpoints; merge and prod-migration apply stay human. Bounded by hard agent/budget ceilings and diff-scaled depth.',
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
// HARD CEILINGS — these actually fire mid-flight (checked before EVERY agent
// spawn), unlike the old MAX_BUDGET which was only checked between rounds and
// let a single review round / gate loop blow past it.
//
// NOTE ON WALL-CLOCK: the Workflow runtime forbids Date.now()/new Date(), so a
// wall-clock ceiling cannot be enforced from inside this script. It must be
// enforced by the operator/monitor (watch /workflows; TaskStop if it stalls).
// The agent-count + budget ceilings below are the in-script backstops.
// ---------------------------------------------------------------------------
const MAX_BUDGET = 750_000                                   // output-token self-cap
const MAX_AGENTS = budget.total ? Math.min(400, Math.floor(budget.total / 12_000)) : 60
const MAX_FINDER_ROUNDS = budget.total ? 3 : 1
const MAX_VERIFY_FINDINGS = 8                                // only verify top-N by severity
const HIGH_VOTES = budget.total ? 3 : 2                      // CRITICAL/HIGH skeptic votes
const MED_VOTES = 1                                          // MEDIUM gets 1; LOW is not verified
const MAX_GATE_REPAIRS = 2

// args may arrive as an object OR a JSON-encoded string — tolerate both.
let _args = args
if (typeof _args === 'string') { try { _args = JSON.parse(_args) } catch (e) { _args = {} } }
if (!_args || typeof _args !== 'object') _args = {}
const task = _args.task ? String(_args.task) : null
const baseBranch = _args.baseBranch ? String(_args.baseBranch) : 'main'

// --- guarded agent wrapper: enforces MAX_AGENTS + MAX_BUDGET before spawning --
let agentCount = 0
let aborted = false
async function A(prompt, opts) {
  if (aborted) return null
  if (agentCount >= MAX_AGENTS || budget.spent() >= MAX_BUDGET) {
    if (!aborted) { aborted = true; log(`ceiling hit — agents=${agentCount} spent=${Math.round(budget.spent() / 1000)}k; degrading to ship`) }
    return null
  }
  agentCount += 1
  return agent(prompt, opts)
}

const SEV_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
const votesFor = (sev) => (sev === 'CRITICAL' || sev === 'HIGH') ? HIGH_VOTES : (sev === 'MEDIUM' ? MED_VOTES : 0)
const keyOf = (f) => `${f.file}:${f.line}:${f.summary}`

// --- schemas ---
const SCOPE_SCHEMA = {
  type: 'object',
  required: ['files', 'flags', 'trivial', 'branch'],
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    // The branch the implement step actually created. Every later agent is
    // pinned to it — see BRANCH GUARD below.
    branch: { type: 'string' },
    // trivial = comment/doc/config-only, no logic/type/test/behaviour change.
    trivial: { type: 'boolean' },
    flags: {
      type: 'object',
      required: ['TOUCHES_DB', 'TOUCHES_API', 'TOUCHES_AUTH', 'TOUCHES_PERF', 'TOUCHES_UI'],
      properties: {
        TOUCHES_DB: { type: 'boolean' },
        TOUCHES_API: { type: 'boolean' },
        TOUCHES_AUTH: { type: 'boolean' },
        TOUCHES_PERF: { type: 'boolean' },
        TOUCHES_UI: { type: 'boolean' },
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
const VERDICT_SCHEMA = { type: 'object', required: ['real', 'reason'], properties: { real: { type: 'boolean' }, reason: { type: 'string' } } }
// `branch` is required so a gate result carries the branch it MEASURED. Agents
// share one working tree; a checkout by any one of them can move the tree under
// the others. On the 2026-08-03 branch-C run the fast gate reported PASS with
// "Branch: docs/linkedin-export-verified" — a different branch entirely — and
// the run then reported a gate result for work it had never compiled.
const GATE_SCHEMA = {
  type: 'object',
  required: ['green', 'summary', 'branch'],
  properties: { green: { type: 'boolean' }, summary: { type: 'string' }, branch: { type: 'string' } },
}

async function run() {
  if (!task) return { error: 'forge-ship: no task provided (args.task is empty).' }

  // -- Plan -----------------------------------------------------------------
  phase('Plan')
  const plan = await A(
    `PLAN phase of an autonomous forge run. Task:\n\n${task}\n\nDo a REUSE-AUDIT first ` +
    `(existing migrations, routes, env vars, deps — flag anything already on ${baseBranch}). ` +
    `Then a concrete plan: files to touch, whether it needs tests, any migration. Branch from ` +
    `${baseBranch} as feat/… or fix/…. Return the plan as text.`,
    { phase: 'Plan', label: 'plan' },
  )
  if (aborted) return finish(null, { green: false, summary: 'aborted before implement' }, [], 0, plan)

  // -- Implement (TDD-first UNLESS the change is trivial) --------------------
  phase('Implement')
  await A(
    `Implement the task on a new branch off ${baseBranch}. TDD-first (author tests from the ` +
    `contract, confirm RED, implement to GREEN) UNLESS the change is trivial (comment/doc/config ` +
    `only) — then no tests. Read before write; scope edits to the live path. Write any migration ` +
    `additively (IF NOT EXISTS) but DO NOT apply it to prod. Plan:\n\n${plan}`,
    { phase: 'Implement', label: 'implement' },
  )

  // -- Scope: changed-file set, TOUCHES_* flags, and a TRIVIAL judgement -----
  const scope = await A(
    `Run \`bash scripts/forge-scope.sh ${baseBranch}\` (copy it from this plugin into scripts/ ` +
    `first if absent). Return its changed-file set and flags. Also return \`branch\` = the output ` +
    `of \`git rev-parse --abbrev-ref HEAD\` (the branch implement created — NOT ${baseBranch}), ` +
    `set TOUCHES_UI (any .tsx/.jsx or component/page change) and trivial=true ONLY if the whole ` +
    `diff is comment/doc/config with zero logic/type/test/behaviour change.`,
    { phase: 'Implement', label: 'scope', schema: SCOPE_SCHEMA },
  )
  const files = (scope && scope.files) ? scope.files : []
  const flags = (scope && scope.flags) ? scope.flags : {}
  const trivial = !!(scope && scope.trivial)
  const branch = (scope && scope.branch) ? String(scope.branch).trim() : ''
  const scopeLine = files.length ? files.join('\n') : '(scope empty — review the working diff)'

  // --- BRANCH GUARD ---------------------------------------------------------
  // Every agent from here on shares ONE working tree. Without this, a checkout
  // by any agent silently relocates the review/gate/ship steps to whatever
  // branch the tree happens to be on, and the run reports results for code it
  // never looked at. Prepended to every downstream prompt; the gate result also
  // reports the branch it measured, and a mismatch is treated as NOT green.
  const onBranch = branch
    ? `WORKING BRANCH: \`${branch}\`. Before anything else run ` +
      `\`git rev-parse --abbrev-ref HEAD\`; if it is not \`${branch}\`, run \`git checkout ${branch}\`. ` +
      `Never review, gate or measure any other branch — say so and stop instead.\n\n`
    : ''
  if (!branch) log('WARNING: scope did not report a branch — the branch guard is INACTIVE for this run')

  // Reviewers: trivial ⇒ a minimal lens set; else the full battery gated by flags.
  const activeReviewers = trivial
    ? ['code-reviewer', 'security-reviewer']
    : [
        'code-reviewer', 'security-reviewer', 'typescript-reviewer',
        'silent-failure-hunter', 'refactor-cleaner',
      ]
        .concat(flags.TOUCHES_PERF ? ['performance-optimizer'] : [])
        .concat((flags.TOUCHES_DB || flags.TOUCHES_API || flags.TOUCHES_AUTH) ? ['database-reviewer'] : [])

  // -- Review (barrier per round) → dedup+cap → severity-tiered verify -------
  phase('Review')
  const confirmed = []
  const seen = new Set()
  let round = 0
  while (round < MAX_FINDER_ROUNDS && !aborted) {
    round += 1

    const roundFindings = (await parallel(activeReviewers.map((r) => () =>
      A(
        `${onBranch}${r}: review ONLY these changed files (never audit the repo):\n${scopeLine}\n\nRound ` +
        `${round}. Return compact findings — severity · file:line · one-line. If the change is ` +
        `genuinely fine, return an EMPTY findings array; do not invent issues.`,
        { phase: 'Review', label: `review:${r}`, schema: FINDINGS_SCHEMA },
      ).then((x) => (x && x.findings) ? x.findings : []),
    ))).filter(Boolean).flat()

    // Dedup vs everything seen, then cap to the top-N by severity (kills the N×votes blow-up).
    const fresh = roundFindings.filter((f) => f && !seen.has(keyOf(f)))
    fresh.forEach((f) => seen.add(keyOf(f)))
    const ranked = fresh
      .sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9))
      .slice(0, MAX_VERIFY_FINDINGS)

    phase('Verify')
    const verified = await parallel(ranked.map((f) => () => {
      const n = votesFor(f.severity)
      if (n === 0 || aborted) return Promise.resolve({ ...f, real: false }) // LOW is not worth a vote
      return parallel(Array.from({ length: n }, (_, i) => () =>
        A(
          `${onBranch}Adversarially verify — try to REFUTE with evidence (cite file:line). Default real=false ` +
          `if uncertain.\n${f.severity} ${f.file}:${f.line} — ${f.summary}\n(skeptic ${i + 1})`,
          { phase: 'Verify', label: `verify:${f.file}:${f.line}`, schema: VERDICT_SCHEMA },
        ),
      )).then((votes) => {
        const good = votes.filter(Boolean)
        return { ...f, real: good.length > 0 && good.filter((v) => v.real).length * 2 >= good.length }
      })
    }))

    const added = verified.filter((f) => f && f.real)
    confirmed.push(...added)
    log(`round ${round}: reviewed ${activeReviewers.length}, ${fresh.length} fresh, +${added.length} confirmed; agents=${agentCount} spent=${Math.round(budget.spent() / 1000)}k`)
    if (added.length === 0) break // dry round — stop
  }

  // -- Resolve confirmed CRITICAL/HIGH/MEDIUM -------------------------------
  phase('Resolve')
  const mustFix = confirmed.filter((f) => f.severity !== 'LOW')
  if (mustFix.length && !aborted) {
    await A(
      `${onBranch}Resolve these verified findings — fix each, or justify inline with a code comment. Do not ` +
      `"fix" non-bugs; NEVER edit tests/specs to make them pass.\n` +
      mustFix.map((f) => `- ${f.severity} ${f.file}:${f.line} — ${f.summary}`).join('\n'),
      { phase: 'Resolve', label: 'resolve' },
    )
  }

  // -- Gate: FAST gate with bounded source-only repair; SLOW gate ONCE, no loop
  phase('Gate')
  let fast = { green: false, summary: 'not run' }
  let repairs = 0
  while (repairs <= MAX_GATE_REPAIRS && !aborted) {
    fast = (await A(
      `${onBranch}Run the FAST gate through \`bash scripts/gate-summary.sh "<label>" "<command>"\`: lint, ` +
      `tsc (tsconfig.ci if present), and unit tests. Report PASS/failing-excerpt per gate. Return ` +
      `green=true only if ALL passed for real (a skip is NOT a pass). Do NOT run build or e2e here.`,
      { phase: 'Gate', label: `gate:fast-${repairs}`, schema: GATE_SCHEMA },
    )) || { green: false, summary: 'aborted' }
    if (fast.green || aborted) break
    repairs += 1
    if (repairs > MAX_GATE_REPAIRS) break
    await A(
      `${onBranch}The FAST gate is RED. Fix SOURCE only. NEVER edit tests/specs, and do NOT touch e2e. If the ` +
      `failure is pre-existing or flaky rather than caused by this change (verify with ` +
      `git log ${baseBranch}..HEAD), STOP and report it instead of forcing green.\n${fast.summary}`,
      { phase: 'Gate', label: `gate:repair-${repairs}` },
    )
  }

  // Slow gate (build + e2e) runs AT MOST ONCE, never in a loop, and only for a
  // non-trivial UI/build-affecting change whose fast gate is already green.
  let slow = { green: true, summary: 'skipped (trivial / no UI / fast not green)' }
  const needSlow = !trivial && fast.green && (flags.TOUCHES_UI || flags.TOUCHES_API) && !aborted && budget.spent() < MAX_BUDGET
  if (needSlow) {
    slow = (await A(
      `${onBranch}Run the SLOW gate ONCE (no repair loop): build, e2e (Playwright), and any Supabase/RALPH ` +
      `checks, each via gate-summary.sh. Return green + a summary. Do NOT edit tests to pass.`,
      { phase: 'Gate', label: 'gate:slow', schema: GATE_SCHEMA },
    )) || { green: false, summary: 'aborted' }
  }
  // A gate that measured a DIFFERENT branch proves nothing about this one. Treat
  // the mismatch as red rather than inheriting a green from unrelated code.
  const measuredWrong = (g) => branch && g && g.branch && String(g.branch).trim() !== branch
  const wrongBranchGates = [['fast', fast], ['slow', slow]].filter(([, g]) => measuredWrong(g))
  for (const [which, g] of wrongBranchGates) {
    log(`GATE DISCARDED — the ${which} gate measured \`${String(g.branch).trim()}\`, not \`${branch}\``)
    g.green = false
    g.summary = `measured the WRONG branch (${String(g.branch).trim()} ≠ ${branch}) — result discarded. ${g.summary}`
  }
  const gateGreen = fast.green && slow.green

  // -- Ship: commit, push named branch, open do-NOT-merge PR ----------------
  phase('Ship')
  const ship = await A(
    `${onBranch}Commit per logical step and push the named branch (only that branch) off ${baseBranch}. Open ` +
    `a PR marked "do NOT merge to main without review". ` +
    (gateGreen
      ? `Gate GREEN — open a normal PR.`
      : `Gate RED — open a DRAFT PR titled "[gate-red] …" with the failing diagnosis; do NOT force ` +
        `it green.`) +
    ` Substantive body (inventory, decisions, gate results). If a migration exists, post the ` +
    `Supabase Migration Required comment and note it was NOT applied to prod (human-gated); else ` +
    `post "No Supabase action needed for this branch." Return the PR URL as text.`,
    { phase: 'Ship', label: 'ship' },
  )

  // -- Gap-audit ------------------------------------------------------------
  phase('Gap-audit')
  const gapAudit = await A(
    `Audit the original task item-by-item: ✅ done & verified / ⚠️ consciously omitted (reason) / ` +
    `⛔ open / 🧹 housekeeping. Only claim what passed its gate.\n\nTASK:\n${task}\nFIXED: ` +
    `${mustFix.length}  GATE GREEN: ${gateGreen}  PR: ${ship}`,
    { phase: 'Gap-audit', label: 'gap-audit' },
  )

  return finish(ship, { green: gateGreen, summary: `fast=${fast.summary}; slow=${slow.summary}` }, confirmed, round, gapAudit)
}

function finish(prUrl, gate, confirmed, rounds, gapAudit) {
  return {
    prUrl: prUrl || null,
    gateGreen: !!(gate && gate.green),
    gateSummary: gate ? gate.summary : 'n/a',
    confirmedFindings: confirmed ? confirmed.length : 0,
    reviewRounds: rounds || 0,
    agentsSpawned: agentCount,
    tokensSpent: budget.spent(),
    aborted,
    cappedReason: aborted ? (agentCount >= MAX_AGENTS ? `MAX_AGENTS (${MAX_AGENTS})` : `MAX_BUDGET (${MAX_BUDGET})`) : null,
    gapAudit: gapAudit || null,
  }
}

return await run()
