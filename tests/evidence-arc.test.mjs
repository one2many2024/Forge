// The evidence arc end to end: build, ship and the Workflow engine all run forge-evidence.mjs;
// the engine freezes before implementing, grades after the gate, pins the evidence run to the
// working branch, and never trusts a result measured on another branch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const SRC = read('workflows/forge-auto.js')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// @mutation-verified
//   test: "parity guard: build.md, ship.md and forge-auto.js all reference forge-evidence.mjs"
//   2026-11-02: deleted every `forge-evidence.mjs` mention from commands/ship.md, ran
//   `node --test tests/evidence-arc.test.mjs`, watched this test fail with
//   "commands/ship.md never references forge-evidence.mjs", restored the file, saw it pass.
test('parity guard: build.md, ship.md and forge-auto.js all reference forge-evidence.mjs', () => {
  for (const f of ['commands/build.md', 'commands/ship.md', 'workflows/forge-auto.js']) {
    assert.ok(read(f).includes('forge-evidence.mjs'), `${f} never references forge-evidence.mjs`)
  }
})

test('build.md freezes in PHASE A, grades in PHASE B, audits from the result in PHASE C', () => {
  const md = read('commands/build.md')
  const at = (s) => md.indexOf(s)
  assert.ok(at('## PHASE A') < at('forge-evidence.mjs freeze') && at('forge-evidence.mjs freeze') < at('## PHASE B'))
  assert.ok(at('## PHASE B') < at('forge-evidence.mjs --base') && at('forge-evidence.mjs --base') < at('## PHASE C'))
  assert.ok(md.indexOf('evidence.result.json', at('## PHASE C')) > at('## PHASE C'))
  assert.match(md, /Evidence: n✅ n❌ n⚠️ n⏭/)
})

// ── guardEvidence ────────────────────────────────────────────────────────────
function loadGuard() {
  const m = SRC.match(/\/\/ <evidence-guard>[\s\S]*?\n(function guardEvidence[\s\S]*?\n\})\n\/\/ <\/evidence-guard>/)
  assert.ok(m, 'guardEvidence block not found between its markers — the test is stale')
  return new Function(`${m[1]}; return guardEvidence`)()
}

test('guardEvidence: same branch keeps the counts; another branch forces every row open', () => {
  const g = loadGuard()
  const counts = { pass: 3, fail: 1, open: 1, skipped: 1 }
  assert.deepEqual(g({ branch: 'feat/x', counts, ciRan: true }, 'feat/x').counts, counts)
  const wrong = g({ branch: 'main', counts, ciRan: true }, 'feat/x')
  assert.equal(wrong.branchMismatch, true)
  assert.deepEqual(wrong.counts, { pass: 0, fail: 0, open: 6, skipped: 0 })
  assert.equal(g({ counts }, 'feat/x').branchMismatch, true, 'a result with no branch is a mismatch')
  assert.equal(g('ok', 'feat/x').note, 'evidence not recorded', 'a malformed result is not a pass')
  assert.deepEqual(g('ok', 'feat/x').counts, { pass: 0, fail: 0, open: 0, skipped: 0 })
})

// ── the engine under mocked Workflow globals ─────────────────────────────────
async function runEngine(evidenceResult) {
  const calls = []
  const logs = []
  const NONE = { TOUCHES_DB: false, TOUCHES_API: false, TOUCHES_AUTH: false, TOUCHES_PERF: false, TOUCHES_UI: false }
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, prompt })
    const l = opts.label
    if (l === 'plan') return 'PLAN: add a users table'
    if (l === 'freeze') return { frozen: true, source: 'task-prompt', ids: ['R1', 'R2'] }
    if (l === 'scope') return { files: ['src/a.ts'], flags: NONE, trivial: false, branch: 'feat/x' }
    if (l.startsWith('review:')) return { findings: [] }
    if (l.startsWith('gate:fast')) return { green: true, summary: 'PASS', branch: 'feat/x' }
    if (l === 'evidence') return evidenceResult
    if (l === 'ship') return 'https://github.com/o/r/pull/1'
    return 'ok'
  }
  const fn = new AsyncFunction('args', 'budget', 'agent', 'parallel', 'phase', 'log', SRC.replace(/^export /gm, ''))
  const result = await fn({ task: 'Definition of Done:\n- users table exists', codex: 'off' }, { total: 0, spent: () => 0 },
    agent, async (f) => Promise.all(f.map((x) => x())), () => {}, (m) => logs.push(m))
  return { result, calls, logs, prompt: (l) => (calls.find((c) => c.label === l) || {}).prompt || '' }
}

test('engine: freeze before implement (spec/prompt only), evidence after the gate and before ship', async () => {
  const { calls, prompt, result } = await runEngine({ branch: 'feat/x', counts: { pass: 2, fail: 0, open: 0, skipped: 0 }, ciRan: true })
  const order = calls.map((c) => c.label)
  const i = (l) => order.indexOf(l)
  assert.ok(i('plan') < i('freeze') && i('freeze') < i('implement'))
  assert.ok(i('gate:fast-0') < i('evidence') && i('evidence') < i('ship') && i('ship') < i('gap-audit'))
  assert.match(prompt('freeze'), /forge-evidence\.mjs/)
  assert.match(prompt('freeze'), /Do NOT pass --plan-file and NEVER --force/)
  assert.match(prompt('freeze'), /- users table exists/, 'the task reaches the freeze verbatim')
  assert.match(prompt('implement'), /\(R1, R2\)/)
  assert.match(prompt('implement'), /NEVER a status/)
  assert.match(prompt('evidence'), /^WORKING BRANCH: `feat\/x`/, 'pinned exactly like the gate')
  assert.match(prompt('evidence'), /--base main --branch feat\/x/)
  assert.match(prompt('ship'), /\.a5c\/forge\/pr-body\.md/)
  assert.match(prompt('gap-audit'), /EVIDENCE \(computed by forge-evidence\.mjs\): 2✅ 0❌ 0⚠️ 0⏭/)
  assert.match(prompt('gap-audit'), /✅ done & verified ONLY if its evidence row is ✅/)
  assert.deepEqual(result.evidence.counts, { pass: 2, fail: 0, open: 0, skipped: 0 })
})

test('engine: evidence measured on another branch is discarded — every row open, said in the PR and audit', async () => {
  const { result, logs, prompt } = await runEngine({ branch: 'docs/other', counts: { pass: 2, fail: 0, open: 0, skipped: 0 }, ciRan: true })
  assert.equal(result.evidence.branchMismatch, true)
  assert.deepEqual(result.evidence.counts, { pass: 0, fail: 0, open: 2, skipped: 0 })
  assert.ok(logs.some((l) => /EVIDENCE DISCARDED/.test(l)))
  assert.match(prompt('ship'), /measured the wrong branch so every row is open/)
  assert.match(prompt('gap-audit'), /0✅ 0❌ 2⚠️ 0⏭ — measured `docs\/other`, not `feat\/x`/)
})
