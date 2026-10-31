#!/usr/bin/env node
// @ts-check
// forge-codex-review.mjs — Forge's optional cross-model lens: a second opinion from an OpenAI
// model on a diff (review mode) or an implementation plan (plan mode).
//
// Two backends, one setting — FORGE_CODEX=auto|cli|api|off (default auto):
//   auto  Codex CLI if installed AND authenticated → else the OpenAI Responses API if
//         OPENAI_API_KEY is set → else "unavailable".
//   cli   Codex CLI only (never reads OPENAI_API_KEY).
//   api   OpenAI API only, even when Codex is installed.
//   off   disabled.
// Fallback from CLI to API happens ONLY when the CLI cannot run (absent / not logged in). A CLI
// that runs and then times out or returns garbage is reported as such — not retried via the
// API — so a broken CLI is never hidden and latency never doubles.
//
// FAIL-OPEN: always prints ONE JSON envelope on stdout and exits 0. Never throws to the caller.
//
// Usage:
//   node scripts/forge-codex-review.mjs --mode review --base <branch> [--files-from <path>] [--timeout-sec 300] [--model <id>]
//   node scripts/forge-codex-review.mjs --mode plan --plan-file <path> [--timeout-sec 180] [--model <id>]
//
// Env: FORGE_CODEX, OPENAI_API_KEY (api), CODEX_API_KEY (cli auth in CI),
//      FORGE_OPENAI_MODEL (api default model), FORGE_OPENAI_BASE_URL (api base URL).
// Zero dependencies. Node 18+ (global fetch).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MAX_CONTEXT_BYTES = 200 * 1024
const PROBE_TIMEOUT_MS = 15_000
const DEFAULT_API_MODEL = 'gpt-6.1-terra'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
const MODEL_RE = /^[A-Za-z0-9._:-]+$/
// Flags that would let the model write to, or escape, the user's repo. Never passed.
const FORBIDDEN_CLI_ARGS = ['--full-auto', 'danger-full-access', 'workspace-write', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--approve-for-me']

/** @typedef {'ok'|'unavailable'|'error'|'timeout'|'disabled'} Status */
/** @typedef {'cli'|'api'} Backend */
/** @typedef {{severity: string, file: string, line: number, summary: string}} Finding */
/** @typedef {{severity: string, summary: string}} Objection */
/**
 * @typedef {{status: Status, backend: Backend|null, reason: string|null, version: string|null,
 *            model: string|null, findings?: Finding[], objections?: Objection[]}} Envelope
 */
/** @typedef {{code: number|null, stdout: string, stderr: string, timedOut: boolean, spawnError: string|null}} ProcResult */

// ── args ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
/** @param {string} k @param {string|null} [d] */
const arg = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const MODE = arg('--mode', 'review') === 'plan' ? 'plan' : 'review'
const TIMEOUT_MS = Math.max(1, Number(arg('--timeout-sec', MODE === 'plan' ? '180' : '300')) || 300) * 1000
const ITEMS_KEY = MODE === 'plan' ? 'objections' : 'findings'

// ── secrets ───────────────────────────────────────────────────────────────────
/** Redact the literal key values and anything shaped like an OpenAI key. @param {string} text */
function redact(text) {
  let out = String(text || '')
  for (const v of [process.env.OPENAI_API_KEY, process.env.CODEX_API_KEY]) {
    if (v && v.length >= 8) out = out.split(v).join('[REDACTED]')
  }
  return out.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
}
/** A short, redacted, single-line excerpt for `reason`. @param {string} text */
const excerpt = (text) => redact(String(text || '').replace(/\s+/g, ' ').trim()).slice(0, 300)

// ── processes ─────────────────────────────────────────────────────────────────
/**
 * Spawn with an args ARRAY (no shell string). On win32 `codex` is usually a .cmd shim, which
 * Node can only launch through a shell; there every arg is quoted and any arg containing a
 * double quote is rejected rather than escaped.
 * @param {string} cmd @param {string[]} args
 * @param {{input?: string, timeoutMs: number, cwd?: string}} opts
 * @returns {Promise<ProcResult>}
 */
function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32'
    if (win && args.some((a) => a.includes('"'))) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'argument contains a double quote' })
      return
    }
    let child
    try {
      child = spawn(cmd, win ? args.map((a) => `"${a}"`) : args, {
        cwd: opts.cwd, shell: win, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: String(/** @type {Error} */ (e).message || e) })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    /** @param {ProcResult} r */
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL') } catch { /* already gone */ } }, opts.timeoutMs)
    child.stdout.on('data', (b) => { stdout += b })
    child.stderr.on('data', (b) => { stderr += b })
    child.on('error', (e) => done({ code: null, stdout, stderr, timedOut, spawnError: e.message }))
    child.on('close', (code) => done({ code, stdout, stderr, timedOut, spawnError: null }))
    child.stdin.on('error', () => { /* child exited before reading stdin */ })
    child.stdin.end(opts.input || '')
  })
}

/** git is local and fast, so it runs synchronously. '' on any failure. @param {string[]} args */
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
  return r.status === 0 ? String(r.stdout) : ''
}

// ── backend selection ─────────────────────────────────────────────────────────
/** @returns {Promise<{installed: boolean, authed: boolean, version: string|null, why: string|null}>} */
async function probeCli() {
  const v = await run('codex', ['--version'], { timeoutMs: PROBE_TIMEOUT_MS })
  if (v.spawnError || v.timedOut || v.code !== 0) {
    return { installed: false, authed: false, version: null, why: 'codex CLI not found' }
  }
  const version = (v.stdout.trim().split(/\s+/).pop() || '').replace(/[^0-9A-Za-z.+-]/g, '') || null
  if (process.env.CODEX_API_KEY) return { installed: true, authed: true, version, why: null }
  const s = await run('codex', ['login', 'status'], { timeoutMs: PROBE_TIMEOUT_MS })
  if (s.code === 0 && !s.timedOut) return { installed: true, authed: true, version, why: null }
  return { installed: true, authed: false, version, why: 'codex CLI not logged in' }
}

/**
 * @returns {Promise<{backend: Backend|null, version: string|null, status?: Status, reason: string|null}>}
 */
async function selectBackend() {
  const raw = (process.env.FORGE_CODEX || 'auto').trim().toLowerCase()
  const known = ['auto', 'cli', 'api', 'off']
  const mode = known.includes(raw) ? raw : 'auto'
  const note = known.includes(raw) ? '' : `unknown FORGE_CODEX="${excerpt(raw).slice(0, 20)}" treated as auto; `
  if (mode === 'off') return { backend: null, version: null, status: 'disabled', reason: 'FORGE_CODEX=off' }
  const hasKey = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim())
  if (mode === 'api') {
    return hasKey
      ? { backend: 'api', version: null, reason: note || null }
      : { backend: null, version: null, status: 'unavailable', reason: `${note}FORGE_CODEX=api but OPENAI_API_KEY is not set` }
  }
  const cli = await probeCli()
  if (cli.installed && cli.authed) return { backend: 'cli', version: cli.version, reason: note || null }
  if (mode === 'cli') return { backend: null, version: cli.version, status: 'unavailable', reason: `${note}FORGE_CODEX=cli but ${cli.why}` }
  if (hasKey) return { backend: 'api', version: null, reason: `${note}via API (${cli.why})` }
  return { backend: null, version: cli.version, status: 'unavailable', reason: `${note}${cli.why} and OPENAI_API_KEY is not set` }
}

// ── context ───────────────────────────────────────────────────────────────────
/** Prefer origin/<base>: a local ref of the same name is often stale. @param {string} base */
function resolveBase(base) {
  if (/^origin\//.test(base)) return base
  if (git(['rev-parse', '--verify', '--quiet', `origin/${base}`]).trim()) return `origin/${base}`
  return base
}

/**
 * Fit chunks into a shared byte budget; anything cut gets an explicit marker.
 * @param {{label: string, text: string}[]} chunks @param {{left: number}} budget
 */
function fit(chunks, budget) {
  const out = []
  for (const c of chunks) {
    const size = Buffer.byteLength(c.text)
    if (size <= budget.left) { out.push(c.text); budget.left -= size; continue }
    const keep = Math.max(0, budget.left)
    const kept = Buffer.from(c.text).subarray(0, keep).toString('utf-8')
    out.push(`${kept}\n[TRUNCATED: ${size - Buffer.byteLength(kept)} bytes omitted from ${c.label}]\n`)
    budget.left = 0
  }
  return out.join('')
}

/** @param {string} base @param {string|null} filesFrom @param {boolean} withFiles */
function buildReviewContext(base, filesFrom, withFiles) {
  const b = resolveBase(base)
  let files = filesFrom && fs.existsSync(filesFrom)
    ? fs.readFileSync(filesFrom, 'utf-8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : git(['diff', '--name-only', `${b}...HEAD`]).split('\n').map((s) => s.trim()).filter(Boolean)
  files = [...new Set(files)]
  const budget = { left: MAX_CONTEXT_BYTES }
  const diff = fit(files.map((f) => ({ label: f, text: git(['diff', `${b}...HEAD`, '--', f]) })), budget)
  let contents = ''
  if (withFiles) {
    // The API cannot open the repo, so it gets the post-change text of each changed file.
    const root = git(['rev-parse', '--show-toplevel']).trim() || process.cwd()
    contents = fit(files.map((f) => {
      const p = path.join(root, f)
      const body = fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf-8') : '(deleted in this change)'
      return { label: f, text: `\n===== FILE: ${f} =====\n${body}\n` }
    }), budget)
  }
  return { files, diff, contents, base: b }
}

// ── prompts ───────────────────────────────────────────────────────────────────
const REVIEW_INSTRUCTIONS =
  'You are an independent code reviewer from a different model family than the author. ' +
  'Review ONLY the change shown below — do not audit unrelated code. Return compact findings: ' +
  'severity (CRITICAL/HIGH/MEDIUM/LOW), file, line (0 if unknown), and a one-line summary. ' +
  'Prefer correctness, security, data-loss, concurrency and contract bugs over style. If the ' +
  'change is fine, return an EMPTY findings array. Do not invent issues. Do not modify files.'
const PLAN_INSTRUCTIONS =
  'Act as an adversarial reviewer of the implementation plan below. List the strongest ' +
  'objections: wrong assumptions, missing migrations, security/RLS gaps, untestable steps, ' +
  'simpler alternatives. At most 8, each one line, each with a severity ' +
  '(CRITICAL/HIGH/MEDIUM/LOW). If the plan is sound, return an EMPTY objections array.'

// ── validation ────────────────────────────────────────────────────────────────
/** @param {any} parsed @returns {{items: any[], dropped: number}} */
function normalise(parsed) {
  const raw = parsed && Array.isArray(parsed[ITEMS_KEY]) ? parsed[ITEMS_KEY] : null
  if (!raw) return { items: [], dropped: -1 }
  const items = []
  let dropped = 0
  for (const it of raw) {
    const sevOk = it && SEVERITIES.includes(it.severity)
    const sumOk = it && typeof it.summary === 'string' && it.summary.trim()
    if (MODE === 'plan') {
      if (sevOk && sumOk) items.push({ severity: it.severity, summary: it.summary.trim() })
      else dropped++
    } else {
      const fileOk = it && typeof it.file === 'string' && it.file.trim()
      const lineOk = it && Number.isInteger(it.line) && it.line >= 0
      if (sevOk && sumOk && fileOk && lineOk) items.push({ severity: it.severity, file: it.file.trim(), line: it.line, summary: it.summary.trim() })
      else dropped++
    }
  }
  return { items: MODE === 'plan' ? items.slice(0, 8) : items, dropped }
}

/** @param {string} text */
function parseJson(text) {
  try { return JSON.parse(text) } catch { /* fall through */ }
  const m = String(text || '').match(/\{[\s\S]*\}/) // tolerate stray prose around the object
  if (m) { try { return JSON.parse(m[0]) } catch { /* unparseable */ } }
  return null
}

// ── backends ──────────────────────────────────────────────────────────────────
/** @param {string} input @param {string} schemaPath @param {string|null} model @param {string} cwd */
async function callCli(input, schemaPath, model, cwd) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-codex-'))
  const outFile = path.join(tmp, 'last-message.json')
  try {
    const args = ['exec', '-s', 'read-only', '--ephemeral', '--color', 'never', '-C', cwd,
      '--output-schema', schemaPath, '-o', outFile]
    if (model) args.push('-m', model)
    args.push('-') // instructions + context on stdin
    if (args.some((a) => FORBIDDEN_CLI_ARGS.includes(a))) throw new Error('refusing a write-capable codex invocation')
    const r = await run('codex', args, { input, timeoutMs: TIMEOUT_MS, cwd })
    if (r.timedOut) return { status: /** @type {Status} */ ('timeout'), reason: `codex exec exceeded ${TIMEOUT_MS / 1000}s`, text: '' }
    if (r.spawnError) return { status: /** @type {Status} */ ('error'), reason: `codex exec could not start: ${excerpt(r.spawnError)}`, text: '' }
    if (r.code !== 0) return { status: /** @type {Status} */ ('error'), reason: `codex exec exited ${r.code}: ${excerpt(r.stderr || r.stdout)}`, text: '' }
    const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8') : r.stdout
    return { status: /** @type {Status} */ ('ok'), reason: null, text }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/** @param {string} input @param {object} schema @param {string} model */
async function callApi(input, schema, model) {
  const base = (process.env.FORGE_OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/responses`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model,
        store: false, // do not retain the user's code on OpenAI's side
        instructions: MODE === 'plan' ? PLAN_INSTRUCTIONS : REVIEW_INSTRUCTIONS,
        input,
        text: { format: { type: 'json_schema', name: `forge_${MODE}`, strict: true, schema } },
      }),
    })
    const body = await res.text()
    if (!res.ok) {
      const j = parseJson(body)
      const msg = j && j.error && j.error.message ? j.error.message : body
      return { status: /** @type {Status} */ ('error'), reason: `OpenAI API HTTP ${res.status}: ${excerpt(msg)}`, text: '' }
    }
    const j = parseJson(body)
    if (!j) return { status: /** @type {Status} */ ('error'), reason: 'OpenAI API returned non-JSON', text: '' }
    if (typeof j.output_text === 'string') return { status: /** @type {Status} */ ('ok'), reason: null, text: j.output_text }
    let text = ''
    for (const item of Array.isArray(j.output) ? j.output : []) {
      for (const c of Array.isArray(item && item.content) ? item.content : []) {
        if (c && c.type === 'refusal') return { status: /** @type {Status} */ ('error'), reason: `model refused: ${excerpt(c.refusal || '')}`, text: '' }
        if (c && c.type === 'output_text' && typeof c.text === 'string') text += c.text
      }
    }
    return { status: /** @type {Status} */ ('ok'), reason: null, text }
  } catch (e) {
    const err = /** @type {Error} */ (e)
    if (err && err.name === 'AbortError') return { status: /** @type {Status} */ ('timeout'), reason: `OpenAI API exceeded ${TIMEOUT_MS / 1000}s`, text: '' }
    return { status: /** @type {Status} */ ('error'), reason: `OpenAI API request failed: ${excerpt(err && err.message)}`, text: '' }
  } finally {
    clearTimeout(timer)
  }
}

// ── persistence (inside .git/, never committed) ───────────────────────────────
/** @param {Envelope} env */
function persist(env) {
  try {
    const gd = git(['rev-parse', '--git-dir']).trim()
    if (!gd) return
    const dir = path.join(path.resolve(gd), 'forge')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `codex-${MODE}.json`), JSON.stringify({ mode: MODE, writtenAt: new Date().toISOString(), ...env }, null, 2))
  } catch { /* persistence is best-effort; the envelope on stdout is authoritative */ }
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  /** @type {Envelope} */
  const env = { status: 'unavailable', backend: null, reason: null, version: null, model: null, [ITEMS_KEY]: [] }

  const sel = await selectBackend()
  env.version = sel.version
  if (!sel.backend) { env.status = sel.status || 'unavailable'; env.reason = sel.reason; return env }
  env.backend = sel.backend

  const cliModel = arg('--model', null)
  const apiModel = arg('--model', null) || process.env.FORGE_OPENAI_MODEL || DEFAULT_API_MODEL
  const model = sel.backend === 'api' ? apiModel : cliModel
  if (model && !MODEL_RE.test(model)) { env.status = 'error'; env.reason = 'invalid model id'; return env }
  env.model = model

  const schemaPath = path.join(HERE, `forge-codex-review.schema.${MODE}.json`)
  if (!fs.existsSync(schemaPath)) { env.status = 'error'; env.reason = `schema missing: ${path.basename(schemaPath)}`; return env }
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'))

  let context
  if (MODE === 'plan') {
    const pf = arg('--plan-file', null)
    if (!pf || !fs.existsSync(pf)) { env.status = 'error'; env.reason = '--plan-file missing or unreadable'; return env }
    context = fit([{ label: path.basename(pf), text: fs.readFileSync(pf, 'utf-8') }], { left: MAX_CONTEXT_BYTES })
    context = `<plan>\n${context}\n</plan>`
  } else {
    const c = buildReviewContext(arg('--base', 'main') || 'main', arg('--files-from', null), sel.backend === 'api')
    if (!c.diff.trim()) { env.status = 'ok'; env.reason = joinReason(sel.reason, `empty diff against ${c.base}`); return env }
    context = `<diff base="${c.base}">\n${c.diff}\n</diff>` + (c.contents ? `\n<changed-files>${c.contents}\n</changed-files>` : '')
  }

  const cwd = git(['rev-parse', '--show-toplevel']).trim() || process.cwd()
  const r = sel.backend === 'cli'
    ? await callCli(`${MODE === 'plan' ? PLAN_INSTRUCTIONS : REVIEW_INSTRUCTIONS}\n\n${context}`, schemaPath, model, cwd)
    : await callApi(context, schema, /** @type {string} */ (model))

  if (r.status !== 'ok') { env.status = r.status; env.reason = joinReason(sel.reason, r.reason); return env }
  const parsed = parseJson(r.text)
  const { items, dropped } = normalise(parsed)
  if (!parsed || dropped < 0) { env.status = 'error'; env.reason = joinReason(sel.reason, 'unparseable model output'); return env }
  env.status = 'ok'
  env[ITEMS_KEY] = items
  env.reason = joinReason(sel.reason, dropped ? `dropped ${dropped} invalid item(s)` : null)
  return env
}

/** @param {...(string|null)} parts */
function joinReason(...parts) { const s = parts.filter(Boolean).join('; '); return s ? excerpt(s) : null }

main()
  .catch((e) => /** @type {Envelope} */ ({ status: 'error', backend: null, reason: `internal error: ${excerpt(String(e && e.message))}`, version: null, model: null, [ITEMS_KEY]: [] }))
  .then((env) => {
    if (env.reason) env.reason = excerpt(env.reason)
    persist(env)
    process.stdout.write(JSON.stringify(env) + '\n')
    process.exitCode = 0
  })
