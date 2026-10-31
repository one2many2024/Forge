// The run summary's Cross-model line: from --codex-lens (ship), from the envelopes the runner
// persists in <git-dir>/forge/ (build), and "not recorded" when neither exists. Fixture
// transcripts keep the rest of the summary realistic; the verdict must not change.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SUMMARY = path.join(ROOT, 'scripts', 'forge-summary.mjs')
let tmp, repo, session

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-summary-test-'))
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' })
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
  fs.writeFileSync(path.join(repo, 'a.js'), '1\n'); g('add', '.'); g('commit', '-qm', 'init')
  g('checkout', '-qb', 'feat/x'); fs.writeFileSync(path.join(repo, 'a.js'), '2\n'); g('commit', '-qam', 'x')

  // A fixture transcript: one main-loop turn and one finished agent, written "now".
  const now = new Date().toISOString()
  session = path.join(tmp, 'session.jsonl')
  fs.writeFileSync(session, [
    JSON.stringify({ type: 'assistant', timestamp: now, message: { usage: { output_tokens: 1200, input_tokens: 10 } } }),
    JSON.stringify({ type: 'user', timestamp: now, message: { content: '<task-notification><task-id>t1</task-id>Agent "review:code-reviewer" finished<usage><subagent_tokens>3400</subagent_tokens></usage></task-notification>' } }),
  ].join('\n') + '\n')
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const summary = (...extra) => execFileSync(process.execPath, [SUMMARY, '--session', session, '--cwd', repo, '--base', 'main', ...extra], { encoding: 'utf-8' })
const crossLine = (out) => out.split('\n').find((l) => l.startsWith('Cross-model:'))
const verdictLine = (out) => out.split('\n').find((l) => l.startsWith('Verdict:'))

test('not recorded when there is neither --codex-lens nor a persisted envelope', () => {
  const out = summary()
  assert.equal(crossLine(out), 'Cross-model: not recorded')
})

test('ok, from --codex-lens: backend, raw → confirmed, objections, marked external', () => {
  const lens = { status: 'ok', backend: 'api', reason: 'via API (codex CLI not logged in)', rawFindings: 3, confirmed: 1, planObjections: 2 }
  const before = verdictLine(summary())
  const out = summary('--codex-lens', JSON.stringify(lens))
  const line = crossLine(out)
  assert.match(line, /^Cross-model: ok via api \(via API \(codex CLI not logged in\)\)/)
  assert.match(line, /findings 3 raw → 1 confirmed · plan objections 2/)
  assert.match(line, /external — not metered \(billed to the user's OpenAI\/ChatGPT account\)/)
  assert.equal(verdictLine(out), before, 'the verdict is unaffected by the lens')
})

test('unavailable, from --codex-lens: status and reason, no invented counts', () => {
  const lens = { status: 'unavailable', backend: 'none', reason: 'codex CLI not found and OPENAI_API_KEY is not set', rawFindings: 0, confirmed: 0, planObjections: 0 }
  const line = crossLine(summary('--codex-lens', JSON.stringify(lens)))
  assert.match(line, /^Cross-model: unavailable \(codex CLI not found and OPENAI_API_KEY is not set\)/)
  assert.ok(!/via none/.test(line))
})

test('disabled is reported as disabled', () => {
  const line = crossLine(summary('--codex-lens', JSON.stringify({ status: 'disabled', backend: 'none', reason: 'FORGE_CODEX=off' })))
  assert.equal(line, 'Cross-model: disabled (FORGE_CODEX=off)')
})

test('build path: persisted envelopes give raw counts, confirmed stays n/a', () => {
  const dir = path.join(repo, '.git', 'forge')
  fs.mkdirSync(dir, { recursive: true })
  const writtenAt = new Date().toISOString()
  fs.writeFileSync(path.join(dir, 'codex-review.json'), JSON.stringify({ mode: 'review', writtenAt, status: 'ok', backend: 'cli', reason: null, findings: [{}, {}] }))
  fs.writeFileSync(path.join(dir, 'codex-plan.json'), JSON.stringify({ mode: 'plan', writtenAt, status: 'ok', backend: 'cli', reason: null, objections: [{}] }))
  try {
    const line = crossLine(summary())
    assert.match(line, /^Cross-model: ok via cli · findings 2 raw → n\/a confirmed · plan objections 1/)
    // An envelope older than --since belongs to an earlier run and is ignored.
    const later = new Date(Date.now() + 60_000).toISOString()
    assert.equal(crossLine(summary('--since', later)), 'Cross-model: not recorded')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
