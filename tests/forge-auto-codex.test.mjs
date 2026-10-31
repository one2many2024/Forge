// Regression + integration tests for the cross-model lens in workflows/forge-auto.js.
// 1. selectReviewers() — extracted from between its markers and run as a pure function.
// 2. The whole engine, driven by mocked Workflow globals (agent/parallel/phase/log/budget):
//    FORGE_CODEX=off must spawn no cross-model agent and leave every prompt free of it;
//    with the lens on, plan objections reach Implement and Codex findings go through the
//    same Claude skeptic verification as every other finding.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'forge-auto.js'), 'utf8').replace(/\r\n/g, '\n')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// ── 1. selectReviewers ───────────────────────────────────────────────────────
function loadSelectReviewers() {
  const m = SRC.match(/\/\/ <select-reviewers>[\s\S]*?\n(function selectReviewers[\s\S]*?\n\})\n\/\/ <\/select-reviewers>/)
  assert.ok(m, 'selectReviewers block not found between its markers — the test is stale')
  return new Function(`${m[1]}; return selectReviewers`)()
}
const BASE = ['code-reviewer', 'security-reviewer', 'typescript-reviewer', 'silent-failure-hunter', 'refactor-cleaner']
const NONE = { TOUCHES_DB: false, TOUCHES_API: false, TOUCHES_AUTH: false, TOUCHES_PERF: false }

test('selectReviewers: trivial ⇒ [code, security] in every mode', () => {
  const sel = loadSelectReviewers()
  for (const mode of ['auto', 'cli', 'api', 'off']) {
    assert.deepEqual(sel(true, { ...NONE, TOUCHES_DB: true }, mode), ['code-reviewer', 'security-reviewer'])
  }
})

test('selectReviewers: non-trivial + auto/cli/api ⇒ existing list + codex-reviewer', () => {
  const sel = loadSelectReviewers()
  for (const mode of ['auto', 'cli', 'api']) {
    assert.deepEqual(sel(false, NONE, mode), [...BASE, 'codex-reviewer'])
    assert.deepEqual(sel(false, { ...NONE, TOUCHES_PERF: true, TOUCHES_API: true }, mode),
      [...BASE, 'performance-optimizer', 'database-reviewer', 'codex-reviewer'])
  }
})

test('selectReviewers: off ⇒ the existing list, unchanged', () => {
  const sel = loadSelectReviewers()
  assert.deepEqual(sel(false, NONE, 'off'), BASE)
  assert.deepEqual(sel(false, { ...NONE, TOUCHES_DB: true }, 'off'), [...BASE, 'database-reviewer'])
})

// ── 2. the engine under mocked Workflow globals ──────────────────────────────
async function runEngine({ codex, codexReview, planChallenge, skepticSaysReal = true }) {
  const calls = []
  const logs = []
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, prompt })
    const l = opts.label
    if (l === 'plan') return 'PLAN: add a users table'
    if (l === 'plan-challenge:codex') return planChallenge
    if (l === 'implement') return 'implemented'
    if (l === 'scope') return { files: ['src/a.ts'], flags: { ...NONE, TOUCHES_UI: false }, trivial: false, branch: 'feat/x' }
    if (l === 'review:codex-reviewer') return codexReview
    if (l.startsWith('review:')) return { findings: [] }
    if (l.startsWith('verify:')) return { real: skepticSaysReal, reason: 'checked' }
    if (l.startsWith('gate:fast')) return { green: true, summary: 'PASS', branch: 'feat/x' }
    if (l === 'ship') return 'https://github.com/o/r/pull/1'
    if (l === 'gap-audit') return 'audit table'
    return 'ok'
  }
  const parallel = async (fns) => Promise.all(fns.map((f) => f()))
  const budget = { total: 0, spent: () => 0 }
  const fn = new AsyncFunction('args', 'budget', 'agent', 'parallel', 'phase', 'log', SRC.replace(/^export /gm, ''))
  const result = await fn({ task: 'add users table', baseBranch: 'main', ...(codex ? { codex } : {}) }, budget, agent, parallel, () => {}, (m) => logs.push(m))
  return { result, calls, logs }
}

test('engine, FORGE_CODEX=off: no cross-model agent, no cross-model text in any prompt', async () => {
  const { result, calls } = await runEngine({ codex: 'off' })
  assert.ok(!calls.some((c) => /codex/i.test(c.label)), 'no codex agent spawned')
  for (const c of calls) assert.ok(!/cross-model/i.test(c.prompt), `prompt for ${c.label} mentions cross-model`)
  assert.equal(result.codexLens.status, 'disabled')
  assert.equal(result.reviewRounds, 1)
})

test('engine, lens ok: plan objections reach Implement; codex findings are skeptic-verified, not bypassed', async () => {
  const { result, calls } = await runEngine({
    codex: 'auto',
    planChallenge: { codexStatus: 'ok', codexBackend: 'api', codexReason: 'via API (codex CLI not logged in)', objections: [{ severity: 'HIGH', summary: 'no RLS on users' }] },
    codexReview: { codexStatus: 'ok', codexBackend: 'api', codexReason: '', findings: [{ severity: 'HIGH', file: 'src/a.ts', line: 7, summary: 'missing tenant scope' }] },
  })
  const impl = calls.find((c) => c.label === 'implement').prompt
  assert.match(impl, /CROSS-MODEL OBJECTIONS \(api\)/)
  assert.match(impl, /HIGH: no RLS on users/)
  const verifies = calls.filter((c) => c.label === 'verify:src/a.ts:7')
  assert.ok(verifies.length >= 1, 'codex finding went to Claude skeptics')
  assert.equal(result.codexLens.status, 'ok')
  assert.equal(result.codexLens.backend, 'api')
  assert.equal(result.codexLens.rawFindings, 1)
  assert.equal(result.codexLens.confirmed, 1)
  assert.equal(result.codexLens.planObjections, 1)
  assert.match(calls.find((c) => c.label === 'ship').prompt, /Cross-model review/)
  assert.match(calls.find((c) => c.label === 'gap-audit').prompt, /never ✅ for a skipped lens/)
})

test('engine: a codex finding the skeptics refute is NOT confirmed', async () => {
  const { result } = await runEngine({
    codex: 'auto',
    planChallenge: { codexStatus: 'ok', codexBackend: 'cli', codexReason: '', objections: [] },
    codexReview: { codexStatus: 'ok', codexBackend: 'cli', codexReason: '', findings: [{ severity: 'HIGH', file: 'src/a.ts', line: 7, summary: 'x' }] },
    skepticSaysReal: false,
  })
  assert.equal(result.codexLens.rawFindings, 1)
  assert.equal(result.codexLens.confirmed, 0)
  assert.equal(result.confirmedFindings, 0)
})

test('engine, lens unavailable: run completes, lens reported as skipped with its reason', async () => {
  const { result, calls, logs } = await runEngine({
    codex: 'auto',
    planChallenge: { codexStatus: 'unavailable', codexBackend: 'none', codexReason: 'codex CLI not found and OPENAI_API_KEY is not set', objections: [] },
    codexReview: { codexStatus: 'unavailable', codexBackend: 'none', codexReason: 'codex CLI not found and OPENAI_API_KEY is not set', findings: [{ severity: 'HIGH', file: 'f', line: 1, summary: 'must be ignored' }] },
  })
  assert.equal(result.prUrl, 'https://github.com/o/r/pull/1')
  assert.equal(result.codexLens.status, 'unavailable')
  assert.equal(result.codexLens.rawFindings, 0, 'findings from a non-ok lens are discarded')
  assert.ok(!calls.some((c) => c.label === 'verify:f:1'))
  assert.ok(!/CROSS-MODEL OBJECTIONS/.test(calls.find((c) => c.label === 'implement').prompt))
  assert.ok(logs.some((l) => /cross-model: unavailable via none/.test(l)))
})

test('engine: the cross-model lens runs once, not every finder round', async () => {
  // A budget enables 3 finder rounds; a confirmed finding each round keeps the loop going.
  const calls = []
  const agent = async (prompt, opts) => {
    calls.push(opts.label)
    if (opts.label === 'scope') return { files: ['a'], flags: { ...NONE, TOUCHES_UI: false }, trivial: false, branch: 'b' }
    if (opts.label === 'plan-challenge:codex') return { codexStatus: 'ok', codexBackend: 'cli', codexReason: '', objections: [] }
    if (opts.label === 'review:codex-reviewer') return { codexStatus: 'ok', codexBackend: 'cli', codexReason: '', findings: [] }
    if (opts.label === 'review:code-reviewer') return { findings: [{ severity: 'HIGH', file: 'a', line: calls.length, summary: `r${calls.length}` }] }
    if (opts.label.startsWith('review:')) return { findings: [] }
    if (opts.label.startsWith('verify:')) return { real: true, reason: '' }
    if (opts.label.startsWith('gate:fast')) return { green: true, summary: 'PASS', branch: 'b' }
    return 'x'
  }
  const fn = new AsyncFunction('args', 'budget', 'agent', 'parallel', 'phase', 'log', SRC.replace(/^export /gm, ''))
  const result = await fn({ task: 't', codex: 'cli' }, { total: 1_000_000, spent: () => 0 }, agent, async (f) => Promise.all(f.map((x) => x())), () => {}, () => {})
  assert.equal(result.reviewRounds, 3)
  assert.equal(calls.filter((l) => l === 'review:codex-reviewer').length, 1)
  assert.equal(calls.filter((l) => l === 'review:code-reviewer').length, 3)
})
