// Tests for scripts/forge-codex-review.mjs — backend selection, fallback rules, both backends,
// fail-open behaviour and secret hygiene. Zero dependencies: a stub `codex` executable placed
// first on PATH, and a stub HTTP server standing in for the OpenAI Responses API.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'forge-codex-review.mjs')
const KEY = 'sk-test-THISISAFAKEKEY1234567890'

let tmp, repo, stubDir, server, baseUrl
const apiCalls = []
let apiBehaviour = { status: 200, body: {} }

const okReview = { findings: [{ severity: 'HIGH', file: 'src/a.js', line: 3, summary: 'null deref on empty input' }] }

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-test-'))

  // A repo with main + a feature branch that changes src/a.js.
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true })
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' })
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't')
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'export const a = 1\n')
  g('add', '.'); g('commit', '-qm', 'init')
  g('checkout', '-qb', 'feat/x')
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'export function a(x) {\n  return x.length\n}\n')
  g('commit', '-qam', 'change a')

  // Stub codex. Behaviour is driven by STUB_* env vars; it logs its argv and stdin.
  stubDir = path.join(tmp, 'bin')
  fs.mkdirSync(stubDir)
  const stub = `#!/usr/bin/env node
const fs = require('fs')
const a = process.argv.slice(2)
const e = process.env
const log = (k, v) => e.STUB_LOG && fs.appendFileSync(e.STUB_LOG, JSON.stringify({ [k]: v }) + '\\n')
log('argv', a)
if (a[0] === '--version') { console.log('codex-cli 9.9.9'); process.exit(0) }
if (a[0] === 'login' && a[1] === 'status') { console.log(e.STUB_LOGIN === '1' ? 'Logged in' : 'Not logged in'); process.exit(e.STUB_LOGIN === '1' ? 0 : 1) }
if (a[0] === 'exec') {
  let input = ''; process.stdin.on('data', (d) => input += d); process.stdin.on('end', () => {
    log('stdin', input)
    const out = a[a.indexOf('-o') + 1]
    const b = e.STUB_EXEC || 'ok'
    if (b === 'sleep') { setTimeout(() => process.exit(0), 10000); return }
    if (b === 'fail') { console.error('boom: auth token ${KEY} rejected; also saw sk-proj-OTHERSECRET999'); process.exit(3) }
    fs.writeFileSync(out, b === 'garbage' ? 'not json at all' : (e.STUB_OUTPUT || '{"findings":[]}'))
    process.exit(0)
  })
  return
}
process.exit(2)
`
  fs.writeFileSync(path.join(stubDir, 'codex'), stub, { mode: 0o755 })
  fs.writeFileSync(path.join(stubDir, 'codex.cmd'), '@node "%~dp0codex" %*\r\n')

  // Stub OpenAI Responses API.
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => { body += d })
    req.on('end', () => {
      apiCalls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') })
      if (apiBehaviour.sleep) return // never answer → client timeout
      res.writeHead(apiBehaviour.status, { 'Content-Type': 'application/json' })
      res.end(typeof apiBehaviour.body === 'string' ? apiBehaviour.body : JSON.stringify(apiBehaviour.body))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`
})

after(() => {
  server.closeAllConnections?.()
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Run the script. opts.cli: include the stub on PATH. Returns {env (parsed stdout), log}. */
function runScript(args, { cli = true, env = {}, cwd = repo } = {}) {
  const logFile = path.join(tmp, `log-${Math.random().toString(36).slice(2)}.jsonl`)
  const PATH = (cli ? stubDir + path.delimiter : '') + path.dirname(process.execPath) + path.delimiter + '/usr/bin' + path.delimiter + '/bin'
  const childEnv = { PATH, HOME: tmp, STUB_LOG: logFile, FORGE_OPENAI_BASE_URL: baseUrl, ...env }
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, ...args], { cwd, env: childEnv })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    c.on('close', (code) => {
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : []
      resolve({ code, out, env: JSON.parse(out), log })
    })
  })
}
const review = ['--mode', 'review', '--base', 'main']
const execArgv = (log) => (log.find((l) => l.argv && l.argv[0] === 'exec') || {}).argv || null

// ── backend selection ────────────────────────────────────────────────────────
test('auto + logged-in CLI → cli backend, findings normalised', async () => {
  const r = await runScript(review, { env: { STUB_LOGIN: '1', STUB_OUTPUT: JSON.stringify(okReview), OPENAI_API_KEY: KEY } })
  assert.equal(r.code, 0)
  assert.equal(r.env.status, 'ok')
  assert.equal(r.env.backend, 'cli')
  assert.equal(r.env.version, '9.9.9')
  assert.deepEqual(r.env.findings, okReview.findings)
})

test('auto + CLI logged out + key → api backend, fallback reason stated', async () => {
  apiBehaviour = { status: 200, body: { output_text: JSON.stringify(okReview) } }
  const r = await runScript(review, { env: { STUB_LOGIN: '0', OPENAI_API_KEY: KEY } })
  assert.equal(r.env.status, 'ok')
  assert.equal(r.env.backend, 'api')
  assert.match(r.env.reason, /via API \(codex CLI not logged in\)/)
  assert.equal(execArgv(r.log), null, 'codex exec must not run')
})

test('auto + no CLI + key → api, reason says CLI not found', async () => {
  apiBehaviour = { status: 200, body: { output_text: JSON.stringify(okReview) } }
  const r = await runScript(review, { cli: false, env: { OPENAI_API_KEY: KEY } })
  assert.equal(r.env.backend, 'api')
  assert.match(r.env.reason, /codex CLI not found/)
})

test('auto + neither → unavailable naming both prerequisites', async () => {
  const r = await runScript(review, { cli: false })
  assert.equal(r.env.status, 'unavailable')
  assert.match(r.env.reason, /codex CLI not found and OPENAI_API_KEY is not set/)
  assert.deepEqual(r.env.findings, [])
})

test('CODEX_API_KEY counts as CLI auth without a login', async () => {
  const r = await runScript(review, { env: { STUB_LOGIN: '0', CODEX_API_KEY: 'ck-123456789' } })
  assert.equal(r.env.backend, 'cli')
})

test('FORGE_CODEX=cli never falls back to the API', async () => {
  const before = apiCalls.length
  const r = await runScript(review, { cli: false, env: { FORGE_CODEX: 'cli', OPENAI_API_KEY: KEY } })
  assert.equal(r.env.status, 'unavailable')
  assert.match(r.env.reason, /FORGE_CODEX=cli but codex CLI not found/)
  assert.equal(apiCalls.length, before, 'API must not be called in cli mode')
})

test('FORGE_CODEX=api uses the API even with a logged-in CLI', async () => {
  apiBehaviour = { status: 200, body: { output_text: JSON.stringify(okReview) } }
  const r = await runScript(review, { env: { FORGE_CODEX: 'api', STUB_LOGIN: '1', OPENAI_API_KEY: KEY } })
  assert.equal(r.env.backend, 'api')
  assert.equal(execArgv(r.log), null)
})

test('FORGE_CODEX=api without a key → unavailable', async () => {
  const r = await runScript(review, { env: { FORGE_CODEX: 'api', STUB_LOGIN: '1' } })
  assert.equal(r.env.status, 'unavailable')
  assert.match(r.env.reason, /OPENAI_API_KEY is not set/)
})

test('FORGE_CODEX=off → disabled, nothing spawned', async () => {
  const r = await runScript(review, { env: { FORGE_CODEX: 'off', STUB_LOGIN: '1', OPENAI_API_KEY: KEY } })
  assert.equal(r.env.status, 'disabled')
  assert.equal(r.log.length, 0)
})

test('unknown FORGE_CODEX value is treated as auto and reported', async () => {
  const r = await runScript(review, { env: { FORGE_CODEX: 'maybe', STUB_LOGIN: '1' } })
  assert.equal(r.env.backend, 'cli')
  assert.match(r.env.reason, /treated as auto/)
})

// ── no fallback on runtime failure ───────────────────────────────────────────
test('CLI timeout → timeout, NOT retried via the API', async () => {
  const before = apiCalls.length
  const r = await runScript([...review, '--timeout-sec', '1'], { env: { STUB_LOGIN: '1', STUB_EXEC: 'sleep', OPENAI_API_KEY: KEY } })
  assert.equal(r.env.status, 'timeout')
  assert.equal(r.env.backend, 'cli')
  assert.equal(apiCalls.length, before)
})

test('CLI non-zero exit → error, stderr redacted, NOT retried via the API', async () => {
  const before = apiCalls.length
  const r = await runScript(review, { env: { STUB_LOGIN: '1', STUB_EXEC: 'fail', OPENAI_API_KEY: KEY } })
  assert.equal(r.env.status, 'error')
  assert.match(r.env.reason, /exited 3/)
  assert.ok(!r.out.includes(KEY), 'key must not leak')
  assert.ok(!r.out.includes('OTHERSECRET999'), 'any key-shaped string is redacted, not only the configured key')
  assert.match(r.env.reason, /\[REDACTED\]/)
  assert.equal(apiCalls.length, before)
})

test('CLI garbage output → error', async () => {
  const r = await runScript(review, { env: { STUB_LOGIN: '1', STUB_EXEC: 'garbage' } })
  assert.equal(r.env.status, 'error')
  assert.match(r.env.reason, /unparseable/)
})

test('invalid items are dropped and counted', async () => {
  const bad = { findings: [okReview.findings[0], { severity: 'URGENT', file: 'x', line: 1, summary: 's' }, { severity: 'LOW', file: '', line: 1, summary: 's' }, { severity: 'LOW', file: 'x', line: 1.5, summary: 's' }] }
  const r = await runScript(review, { env: { STUB_LOGIN: '1', STUB_OUTPUT: JSON.stringify(bad) } })
  assert.equal(r.env.status, 'ok')
  assert.equal(r.env.findings.length, 1)
  assert.match(r.env.reason, /dropped 3 invalid item/)
})

// ── CLI invocation safety ────────────────────────────────────────────────────
test('CLI runs read-only, ephemeral, with the schema, prompt on stdin, no write flags', async () => {
  const r = await runScript(review, { env: { STUB_LOGIN: '1' } })
  const a = execArgv(r.log)
  assert.ok(a, 'exec ran')
  assert.deepEqual(a.slice(a.indexOf('-s'), a.indexOf('-s') + 2), ['-s', 'read-only'])
  for (const f of ['--ephemeral', '--output-schema', '-o']) assert.ok(a.includes(f), `has ${f}`)
  assert.equal(a[a.length - 1], '-')
  for (const bad of ['--full-auto', 'danger-full-access', 'workspace-write', '--dangerously-bypass-approvals-and-sandbox']) {
    assert.ok(!a.includes(bad), `never ${bad}`)
  }
  const stdin = r.log.find((l) => l.stdin).stdin
  assert.match(stdin, /Review ONLY the change/)
  assert.match(stdin, /return x\.length/)
})

// ── API backend ──────────────────────────────────────────────────────────────
test('API request: Responses API, strict json_schema, store:false, key only in header, file contents sent', async () => {
  apiBehaviour = { status: 200, body: { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(okReview) }] }] } }
  const before = apiCalls.length
  const r = await runScript(review, { env: { FORGE_CODEX: 'api', OPENAI_API_KEY: KEY, FORGE_OPENAI_MODEL: 'gpt-test' } })
  assert.equal(r.env.status, 'ok')
  assert.deepEqual(r.env.findings, okReview.findings, 'parses output[].content[] when output_text is absent')
  const call = apiCalls[before]
  assert.equal(call.url, '/v1/responses')
  assert.equal(call.auth, `Bearer ${KEY}`)
  assert.equal(call.body.model, 'gpt-test')
  assert.equal(call.body.store, false)
  assert.equal(call.body.text.format.type, 'json_schema')
  assert.equal(call.body.text.format.strict, true)
  assert.match(call.body.input, /===== FILE: src\/a\.js =====/)
  assert.match(call.body.input, /return x\.length/)
  assert.ok(!JSON.stringify(call.body).includes(KEY), 'key never in the body')
  assert.equal(r.env.model, 'gpt-test')
})

test('API defaults the model when FORGE_OPENAI_MODEL is unset', async () => {
  apiBehaviour = { status: 200, body: { output_text: '{"findings":[]}' } }
  const before = apiCalls.length
  await runScript(review, { env: { FORGE_CODEX: 'api', OPENAI_API_KEY: KEY } })
  assert.equal(apiCalls[before].body.model, 'gpt-6.1-terra')
})

for (const [code, label] of [[401, 'auth'], [429, 'quota'], [500, 'server']]) {
  test(`API HTTP ${code} (${label}) → error, message redacted`, async () => {
    apiBehaviour = { status: code, body: { error: { message: `bad thing, key ${KEY} rejected` } } }
    const r = await runScript(review, { env: { FORGE_CODEX: 'api', OPENAI_API_KEY: KEY } })
    assert.equal(r.env.status, 'error')
    assert.match(r.env.reason, new RegExp(`HTTP ${code}`))
    assert.ok(!r.out.includes(KEY))
  })
}

test('API refusal → error', async () => {
  apiBehaviour = { status: 200, body: { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] } }
  const r = await runScript(review, { env: { FORGE_CODEX: 'api', OPENAI_API_KEY: KEY } })
  assert.equal(r.env.status, 'error')
  assert.match(r.env.reason, /refused/)
})

test('API non-JSON body → error', async () => {
  apiBehaviour = { status: 200, body: '<html>gateway</html>' }
  const r = await runScript(review, { env: { FORGE_CODEX: 'api', OPENAI_API_KEY: KEY } })
  assert.equal(r.env.status, 'error')
})

test('API timeout → timeout', async () => {
  apiBehaviour = { sleep: true }
  const r = await runScript([...review, '--timeout-sec', '1'], { env: { FORGE_CODEX: 'api', OPENAI_API_KEY: KEY } })
  assert.equal(r.env.status, 'timeout')
})

// ── plan mode ────────────────────────────────────────────────────────────────
test('plan mode round-trip on both backends, capped at 8 objections', async () => {
  const planFile = path.join(tmp, 'plan.md')
  fs.writeFileSync(planFile, '1. Add table foo\n2. Ship it\n')
  const objs = { objections: Array.from({ length: 10 }, (_, i) => ({ severity: 'MEDIUM', summary: `objection ${i}` })) }

  const c = await runScript(['--mode', 'plan', '--plan-file', planFile], { env: { STUB_LOGIN: '1', STUB_OUTPUT: JSON.stringify(objs) } })
  assert.equal(c.env.status, 'ok')
  assert.equal(c.env.backend, 'cli')
  assert.equal(c.env.objections.length, 8)
  assert.ok(!('findings' in c.env))
  assert.match(c.log.find((l) => l.stdin).stdin, /Add table foo/)

  apiBehaviour = { status: 200, body: { output_text: JSON.stringify({ objections: [{ severity: 'HIGH', summary: 'no RLS on foo' }] }) } }
  const before = apiCalls.length
  const a = await runScript(['--mode', 'plan', '--plan-file', planFile], { env: { FORGE_CODEX: 'api', OPENAI_API_KEY: KEY } })
  assert.deepEqual(a.env.objections, [{ severity: 'HIGH', summary: 'no RLS on foo' }])
  assert.equal(apiCalls[before].body.text.format.name, 'forge_plan')
})

test('plan mode without a readable plan file → error', async () => {
  const r = await runScript(['--mode', 'plan', '--plan-file', '/nope'], { env: { STUB_LOGIN: '1' } })
  assert.equal(r.env.status, 'error')
})

// ── limits, persistence, secrets ─────────────────────────────────────────────
test('context above 200KB is truncated with an explicit marker', async () => {
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' })
  g('checkout', '-qb', 'feat/big')
  fs.writeFileSync(path.join(repo, 'src', 'big.txt'), 'x'.repeat(300 * 1024) + '\n')
  g('add', '.'); g('commit', '-qm', 'big')
  try {
    const r = await runScript(review, { env: { STUB_LOGIN: '1' } })
    const stdin = r.log.find((l) => l.stdin).stdin
    assert.match(stdin, /\[TRUNCATED: \d+ bytes omitted from src\/big\.txt\]/)
    assert.ok(Buffer.byteLength(stdin) < 260 * 1024)
  } finally {
    g('checkout', '-q', 'feat/x')
  }
})

test('envelope persisted inside .git/forge, never containing the key', async () => {
  apiBehaviour = { status: 200, body: { output_text: JSON.stringify(okReview) } }
  await runScript(review, { env: { FORGE_CODEX: 'api', OPENAI_API_KEY: KEY } })
  const p = path.join(repo, '.git', 'forge', 'codex-review.json')
  assert.ok(fs.existsSync(p))
  const saved = fs.readFileSync(p, 'utf-8')
  assert.equal(JSON.parse(saved).backend, 'api')
  assert.ok(!saved.includes(KEY))
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' })
  assert.equal(status.trim(), '', 'persistence must not dirty the work tree')
})

test('empty diff → ok with no findings, model not called', async () => {
  const r = await runScript(['--mode', 'review', '--base', 'feat/x'], { env: { STUB_LOGIN: '1' } })
  assert.equal(r.env.status, 'ok')
  assert.deepEqual(r.env.findings, [])
  assert.match(r.env.reason, /empty diff/)
  assert.equal(execArgv(r.log), null)
})
