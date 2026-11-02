#!/usr/bin/env node
// forge-evidence.mjs — evidence-backed PRs. Two subcommands:
//
//   freeze   At plan approval, write .a5c/forge/requirements.json: the requirements the PR
//            will be graded against, taken verbatim from the repo's acceptance spec or from
//            the task prompt's Definition of Done. Refuses to overwrite a frozen list unless
//            --force (which the arc only passes after a new human breakpoint).
//
//   report   (default) Grade the frozen requirements. The executing agent declares only WHERE
//            each proof is (.a5c/forge/evidence.json); this script re-runs every runnable proof
//            itself and computes the status. An agent-written status is ignored.
//
// Zero dependencies. Every subprocess is spawned with shell: false, so no pipes and the same
// behaviour on Windows/PowerShell. `report` always exits 0: it reports, it never blocks.
//
// freeze usage:
//   node scripts/forge-evidence.mjs freeze [--spec <file> | --spec-name <name>]
//        [--prompt-file <file>] [--section <regex>] [--plan-file <file>]
//        [--base <ref>] [--cwd <dir>] [--dir <dir>] [--force]
//   --spec / --spec-name  the acceptance spec the task names (a path, or a name matched against
//                    acceptanceGlob). With exactly one spec on disk it is used without naming.
//   --prompt-file    the task prompt; its Definition of Done / requirements list is extracted
//                    verbatim when no acceptance spec applies.
//   --section        regex for the heading whose list holds the requirements
//                    (default: definition of done | requirements | acceptance criteria).
//   --plan-file      PLAN additions, one list item each. Frozen with origin "plan" and shown in
//                    the PR as agent-added. /forge:ship never passes this.
//
// report usage: see the REPORT block further down.

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const SUB = argv[0] && !argv[0].startsWith('--') ? argv.shift() : 'report'
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
const flag = (k) => argv.includes(k)
const CWD = path.resolve(arg('--cwd', process.cwd()))
const BASE = arg('--base', 'main')
const DIR = path.resolve(CWD, arg('--dir', path.join('.a5c', 'forge')))
const REQ_FILE = path.join(DIR, 'requirements.json')
const REQ_REL = path.relative(CWD, REQ_FILE).split(path.sep).join('/')

// ── shared helpers ───────────────────────────────────────────────────────────
// Every text input may come from a Windows checkout: strip a BOM, split CRLF-tolerantly.
const readText = (p) => fs.readFileSync(p, 'utf8').replace(/^﻿/, '')
const lines = (s) => String(s).split(/\r?\n/)
const readJson = (p) => JSON.parse(readText(p))
const posix = (p) => String(p).replace(/\\/g, '/')
function git(...a) {
  try { return execFileSync('git', a, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
}
// Prefer origin/<base>: a local ref of the same name is routinely stale (see forge-summary.mjs).
function resolveBase(base) {
  if (/^origin\//.test(base)) return base
  return git('rev-parse', '--verify', '--quiet', `origin/${base}`) ? `origin/${base}` : base
}
function loadConfig() {
  try { return readJson(path.join(CWD, '.a5c', 'forge.json')) } catch { return {} }
}

// A minimal glob: "<dir>/<name with * wildcards>", no recursion. Enough for acceptanceGlob.
function globFiles(pattern) {
  const p = posix(pattern)
  const dir = path.dirname(p)
  const re = new RegExp('^' + path.basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  try {
    return fs.readdirSync(path.join(CWD, dir)).filter((f) => re.test(f)).sort().map((f) => posix(path.join(dir, f)))
  } catch { return [] }
}

// List items under the first heading (or bold/plain label line) matching `sectionRe`. Items are
// kept verbatim apart from the bullet / number / checkbox marker. Stops at the next heading.
function extractListUnder(text, sectionRe) {
  const ls = lines(text)
  const isHeading = (l) => /^\s{0,3}#{1,6}\s/.test(l)
  const isLabel = (l) => isHeading(l) || /^\s*(\*\*|__)[^*_]+(\*\*|__)\s*:?\s*$/.test(l) || /^\s*[A-Za-z][^:]{0,60}:\s*$/.test(l)
  const start = ls.findIndex((l) => isLabel(l) && sectionRe.test(l))
  if (start < 0) return []
  const items = []
  for (let i = start + 1; i < ls.length; i++) {
    const l = ls[i]
    if (isHeading(l)) break
    const m = l.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/)
    if (m && !/^\s{2,}/.test(l.replace(/^\t/, '  '))) items.push(m[1])
    else if (m) { if (items.length) items[items.length - 1] += ' ' + m[1] } // nested bullet: fold into parent
    else if (items.length && /^\s+\S/.test(l)) items[items.length - 1] += ' ' + l.trim() // wrapped line
  }
  return items
}

// An acceptance spec in any of the shapes repos use: an array, or { requirements | criteria |
// acceptance | items: [...] }, each item carrying an id and its text.
function specRequirements(spec) {
  const list = Array.isArray(spec) ? spec
    : (spec.requirements || spec.criteria || spec.acceptance || spec.items || [])
  return list.map((r, i) => {
    if (typeof r === 'string') return { id: `R${i + 1}`, text: r }
    return { id: String(r.id ?? `R${i + 1}`), text: String(r.text ?? r.description ?? r.title ?? r.requirement ?? '') }
  }).filter((r) => r.text)
}

// ── freeze ───────────────────────────────────────────────────────────────────
function freeze() {
  if (fs.existsSync(REQ_FILE) && !flag('--force')) {
    console.error(`[forge-evidence] ${REQ_REL} is already frozen. Editing it needs a new human ` +
      'breakpoint; only then re-run with --force.')
    return 1
  }
  const cfg = loadConfig()
  const glob = cfg.acceptanceGlob || 'acceptance/*.acceptance.json'
  let specPath = arg('--spec', null)
  const specName = arg('--spec-name', null)
  if (!specPath) {
    const specs = globFiles(glob)
    if (specName) specPath = specs.find((s) => path.basename(s).startsWith(specName) || s.includes(specName)) || null
    else if (specs.length === 1) specPath = specs[0]
    else if (specs.length > 1 && !arg('--prompt-file', null)) {
      console.error(`[forge-evidence] ${specs.length} acceptance specs match ${glob}; name one with --spec-name.`)
      return 1
    }
  }

  let source, requirements
  if (specPath) {
    requirements = specRequirements(readJson(path.resolve(CWD, specPath))).map((r) => ({ ...r, origin: 'spec' }))
    source = 'acceptance-spec'
  } else {
    const pf = arg('--prompt-file', null)
    if (!pf) { console.error('[forge-evidence] no acceptance spec found; pass --prompt-file <task prompt>.'); return 1 }
    const re = new RegExp(arg('--section', 'definition of done|requirements|acceptance criteria'), 'i')
    requirements = extractListUnder(readText(path.resolve(CWD, pf)), re)
      .map((text, i) => ({ id: `R${i + 1}`, text, origin: 'prompt' }))
    source = 'task-prompt'
  }
  if (!requirements.length) {
    console.error('[forge-evidence] found no requirements to freeze (no spec items, no list under a ' +
      'Definition of Done / requirements heading). Pass --section <regex> to name the heading.')
    return 1
  }
  const planFile = arg('--plan-file', null)
  if (planFile) {
    const used = new Set(requirements.map((r) => r.id))
    let n = requirements.length
    for (const text of extractListUnder('# plan\n' + readText(path.resolve(CWD, planFile)), /plan/i)) {
      do n += 1; while (used.has(`R${n}`))
      requirements.push({ id: `R${n}`, text, origin: 'plan' })
    }
  }
  const base = resolveBase(BASE)
  const frozen = {
    frozenAt: new Date().toISOString(),
    frozenCommit: git('merge-base', base, 'HEAD') || git('rev-parse', base) || null,
    source,
    ...(specPath ? { spec: posix(specPath) } : {}),
    requirements,
  }
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(REQ_FILE, JSON.stringify(frozen, null, 2) + '\n')
  // Printed for the approval block.
  console.log(`Frozen requirements (${source}, ${frozen.frozenAt}) → ${REQ_REL}`)
  for (const r of requirements) console.log(`  ${r.id} [${r.origin === 'plan' ? 'plan, agent-added' : r.origin}] ${r.text}`)
  return 0
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORT
//
//   node scripts/forge-evidence.mjs [report] [--base <ref>] [--branch <name>] [--cwd <dir>]
//        [--dir <dir>] [--body <file>] [--template <file>] [--ci-checks <json>] [--no-ci]
//        [--timeout <sec>] [--no-repo-verifier]
//   --branch      the working branch the arc pinned. If HEAD is on any other branch, nothing is
//                 run and every row is ⚠️ open: a proof measured on another branch proves nothing.
//   --body        an existing PR body to insert into (re-runs replace the marked block). Default:
//                 the repo's own .github/PULL_REQUEST_TEMPLATE.md when it exists.
//   --ci-checks   a JSON file of check runs for the PR head ({ check_runs: [...] }); default is to
//                 ask `gh`. --no-ci skips the lookup (reported as ⛔, never as passing).
//
// Writes, under --dir: evidence.md (the PR section), pr-body.md (the section inside the repo's
// template or --body) and evidence.result.json (counts, rows, CI, drift, open items).
// ─────────────────────────────────────────────────────────────────────────────
const ICON = { pass: '✅ pass', fail: '❌ fail', open: '⚠️ open', skipped: '⏭ skipped' }
const TIMEOUT_MS = (Number(arg('--timeout', '300')) || 300) * 1000
const START = '<!-- forge-evidence:start -->'
const END = '<!-- forge-evidence:end -->'

// Spawn without a shell. A bare `npm`/`npx` on Windows is a .cmd shim that Node refuses to
// spawn without a shell, so those two are re-pointed at npm's own JS entry under this Node.
function run(cmd, args, opts = {}) {
  let file = cmd
  let argv2 = args
  if (process.platform === 'win32' && (cmd === 'npm' || cmd === 'npx')) {
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${cmd}-cli.js`)
    if (fs.existsSync(cli)) { file = process.execPath; argv2 = [cli, ...args] }
  }
  const env = { ...process.env, CI: process.env.CI || '1', FORCE_COLOR: '0', NO_COLOR: '1' }
  // When this script itself runs under `node --test`, NODE_TEST_CONTEXT would make a child
  // `node --test` talk the parent's internal protocol instead of printing its report.
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(file, argv2, { cwd: CWD, env, shell: false, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, ...opts })
  return {
    code: r.status,
    error: r.error ? (r.error.code === 'ETIMEDOUT' ? `timed out after ${TIMEOUT_MS / 1000}s` : r.error.message) : null,
    stdout: String(r.stdout || '').replace(/\r\n/g, '\n'),
    stderr: String(r.stderr || '').replace(/\r\n/g, '\n'),
  }
}

// ── runner detection (from package.json) ─────────────────────────────────────
function readPkg() { try { return readJson(path.join(CWD, 'package.json')) } catch { return null } }
const PKG = readPkg()
const deps = PKG ? { ...PKG.dependencies, ...PKG.devDependencies } : {}
const scriptsAll = PKG && PKG.scripts ? Object.values(PKG.scripts).join('\n') : ''
const RUNNERS = {
  vitest: { pkg: 'vitest', bin: 'vitest', args: (f, re) => ['run', f, '-t', re] },
  jest: { pkg: 'jest', bin: 'jest', args: (f, re) => [f, '-t', re] },
  playwright: { pkg: '@playwright/test', bin: 'playwright', args: (f, re) => ['test', f, '-g', re] },
  node: { args: (f, re) => ['--test', '--test-reporter=tap', `--test-name-pattern=${re}`, f] },
}
function detectRunner(type, declared) {
  if (declared && RUNNERS[declared]) return declared
  const has = (n) => deps[n] !== undefined || new RegExp(`\\b${n}\\b`).test(scriptsAll)
  if (type === 'e2e' && (deps['@playwright/test'] !== undefined || /\bplaywright\b/.test(scriptsAll))) return 'playwright'
  if (has('vitest')) return 'vitest'
  if (has('jest')) return 'jest'
  if (/node\s+(?:[^\n]*\s)?--test\b/.test(scriptsAll)) return 'node'
  if (type === 'e2e' && has('playwright')) return 'playwright'
  return null
}
// Run a runner's own bin script under this Node — shell-free on every platform.
function runnerBin(r) {
  const spec = RUNNERS[r]
  if (!spec.pkg) return { file: process.execPath, pre: [] }
  try {
    const pj = path.join(CWD, 'node_modules', ...spec.pkg.split('/'), 'package.json')
    const p = readJson(pj)
    const rel = typeof p.bin === 'string' ? p.bin : p.bin && p.bin[spec.bin]
    if (!rel) return null
    return { file: process.execPath, pre: [path.join(path.dirname(pj), rel)] }
  } catch { return null }
}
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function runNamedTest(proof) {
  const runner = detectRunner(proof.type, proof.runner)
  if (!runner) return { status: 'open', note: 'runner not detected' }
  if (!proof.file || !proof.name) return { status: 'open', note: 'proof needs both file and name' }
  if (!fs.existsSync(path.join(CWD, proof.file))) return { status: 'open', note: `proof file not found: ${proof.file}` }
  const bin = runnerBin(runner)
  if (!bin) return { status: 'open', note: `${runner} is not installed (node_modules)` }
  const r = run(bin.file, [...bin.pre, ...RUNNERS[runner].args(proof.file, escapeRe(proof.name))])
  if (r.error) return { status: 'open', note: `${runner}: ${r.error}` }
  const out = r.stdout + '\n' + r.stderr
  let passed
  if (runner === 'node') {
    // node --test reports a file-level "ok" even when the name filter matched nothing, so the
    // summary count can't be trusted: look for the named test's own TAP line.
    const nameRe = escapeRe(proof.name)
    if (new RegExp(`^\\s*not ok \\d+ - ${nameRe}\\s*(#.*)?$`, 'm').test(out)) return { status: 'fail', note: `${runner}: "${proof.name}" failed` }
    passed = new RegExp(`^\\s*ok \\d+ - ${nameRe}\\s*$`, 'm').test(out) ? 1 : 0
  } else {
    const m = out.match(/(\d+) passed/)
    passed = m ? Number(m[1]) : 0
  }
  if (r.code !== 0) return { status: 'fail', note: `${runner} exit ${r.code}` }
  // Exit 0 with nothing run is not a pass: a typo in the name filters out every test.
  if (passed < 1) return { status: 'open', note: `named test matched 0 tests under ${runner}` }
  return { status: 'pass' }
}

function runCommand(proof) {
  if (!Array.isArray(proof.run) || !proof.run.length || !proof.run.every((x) => typeof x === 'string')) {
    return { status: 'open', note: 'run must be an argv array of strings (no shell, no pipes)' }
  }
  const r = run(proof.run[0], proof.run.slice(1))
  if (r.error) return { status: 'open', note: `could not run ${proof.run[0]}: ${r.error}` }
  const wantExit = proof.expectExit === undefined ? 0 : Number(proof.expectExit)
  if (r.code !== wantExit) return { status: 'fail', note: `exit ${r.code}, expected ${wantExit}` }
  if (proof.expectStdout !== undefined) {
    let re
    try { re = new RegExp(proof.expectStdout, 'm') } catch { return { status: 'open', note: 'expectStdout is not a valid regex' } }
    if (!re.test(r.stdout)) return { status: 'fail', note: `stdout did not match /${proof.expectStdout}/` }
  }
  return { status: 'pass' }
}

// ── proof strength (from git and source) ─────────────────────────────────────
const RESOLVED_BASE = resolveBase(BASE)
const MERGE_BASE = git('merge-base', RESOLVED_BASE, 'HEAD')
const isTestPath = (f) => /(^|\/)(tests?|__tests__|e2e|spec|specs)\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f)
const isMeta = (f) => /^\.a5c\//.test(f)
// Branch commits, oldest first, with the files each one touched.
const branchCommits = (() => {
  if (!MERGE_BASE) return []
  const shas = git('rev-list', '--reverse', `${MERGE_BASE}..HEAD`).split('\n').filter(Boolean)
  return shas.map((sha) => ({ sha, files: git('show', '--name-only', '--format=', sha).split('\n').filter(Boolean).map(posix) }))
})()
const firstImplIdx = branchCommits.findIndex((c) => c.files.some((f) => !isTestPath(f) && !isMeta(f)))

const MOCK_RE = /\bjest\.mock\s*\(|\bvi\.mock\s*\(|\bmsw\b|page\.route\s*\(|__mocks__/
function mutationVerified(src, name) {
  const ls = lines(src)
  for (let i = 0; i < ls.length; i++) {
    if (!ls[i].includes('@mutation-verified')) continue
    const block = [ls[i]]
    for (let j = i + 1; j < ls.length && /^\s*(\/\/|\*|\/\*|#)/.test(ls[j]); j++) block.push(ls[j])
    if (block.join('\n').includes(name)) return true
  }
  return false
}
function strengthOf(proof) {
  const labels = []
  const file = posix(proof.file || '')
  let src = ''
  try { src = readText(path.join(CWD, file)) } catch { /* reported by the runner step */ }
  if (proof.mocked === true) labels.push('mocked')
  else if (src && MOCK_RE.test(src)) labels.push('mocked?')
  if (file && MERGE_BASE) {
    if (execOk('cat-file', '-e', `${MERGE_BASE}:${file}`)) labels.push('pre-existing')
    else {
      const idx = branchCommits.findIndex((c) => c.files.includes(file))
      if (idx < 0) labels.push('uncommitted')
      else if (firstImplIdx < 0 || idx < firstImplIdx) labels.push('frozen before impl')
      else labels.push('new test')
    }
  } else if (file) labels.push('history unavailable')
  if (src && proof.name && mutationVerified(src, proof.name)) labels.push('mutation-verified')
  return labels
}
function execOk(...a) {
  try { execFileSync('git', a, { cwd: CWD, stdio: 'ignore' }); return true } catch { return false }
}

// An artifact must be something a reviewer can open: an http(s) URL, or a file committed in the PR.
function reachable(artifact) {
  if (/^https?:\/\//i.test(artifact)) return true
  const f = posix(artifact).replace(/^\.\//, '')
  return execOk('cat-file', '-e', `HEAD:${f}`)
}

// ── repo-level verifier (npm run verify:acceptance) ──────────────────────────
function repoVerifier() {
  if (flag('--no-repo-verifier') || !PKG || !PKG.scripts || !PKG.scripts['verify:acceptance']) return null
  const r = run('npm', ['run', '--silent', 'verify:acceptance'])
  const text = r.stdout.trim()
  let j = null
  try { j = JSON.parse(text.slice(text.indexOf('{'))) } catch { return { error: 'verify:acceptance did not print a JSON report' } }
  const map = new Map()
  const norm = (v) => {
    if (v === true) return 'pass'
    if (v === false) return 'fail'
    const s = String(v || '').toLowerCase()
    return ['pass', 'passed', 'ok', 'green'].includes(s) ? 'pass' : ['fail', 'failed', 'red'].includes(s) ? 'fail'
      : ['skip', 'skipped'].includes(s) ? 'skipped' : 'open'
  }
  const list = Array.isArray(j) ? j : (j.results || j.requirements || null)
  if (list) for (const x of list) map.set(String(x.id), { status: norm(x.status ?? x.pass ?? x.passed), note: x.note || x.reason || '' })
  else for (const [k, v] of Object.entries(j)) map.set(k, { status: norm(typeof v === 'object' && v ? (v.status ?? v.pass) : v), note: (v && v.note) || '' })
  return { map }
}

// ── CI on the PR head ────────────────────────────────────────────────────────
function ciLine(headSha) {
  let data = null
  let why = ''
  const fixture = arg('--ci-checks', null)
  if (fixture) { try { data = readJson(path.resolve(CWD, fixture)) } catch { why = 'unreadable --ci-checks file' } }
  else if (flag('--no-ci')) why = 'CI lookup disabled (--no-ci)'
  else {
    const r = run('gh', ['api', `repos/{owner}/{repo}/commits/${headSha}/check-runs?per_page=100`])
    if (r.error || r.code !== 0) why = `gh unavailable or not authenticated (${(r.error || r.stderr.split('\n')[0] || `exit ${r.code}`).slice(0, 80)})`
    else { try { data = JSON.parse(r.stdout) } catch { why = 'gh returned unparseable JSON' } }
  }
  const runs = data && Array.isArray(data.check_runs) ? data.check_runs : []
  const remote = git('remote', 'get-url', 'origin').replace(/\.git$/, '')
  const m = remote.match(/github\.com[:/]([^/]+\/[^/]+)$/)
  const link = m ? `https://github.com/${m[1]}/commit/${headSha}/checks` : null
  if (!runs.length) {
    return { ran: false, line: `⛔ CI did not run on this PR's head commit (${headSha.slice(0, 7)})${why ? ` — ${why}` : ''}` }
  }
  const c = (k) => runs.filter((x) => (x.conclusion || x.status) === k).length
  const pending = runs.filter((x) => x.status !== 'completed').length
  const parts = [`${c('success')} ✅`, `${c('failure') + c('timed_out') + c('cancelled')} ❌`]
  if (pending) parts.push(`${pending} pending`)
  return { ran: true, failing: c('failure') + c('timed_out') + c('cancelled'), line: `${runs.length} check run(s) on ${headSha.slice(0, 7)}: ${parts.join(' · ')}${link ? ` — [checks](${link})` : ''}` }
}

// ── drift: requirements.json vs its first committed version ──────────────────
function drift(current) {
  const first = git('log', '--diff-filter=A', '--format=%H', '--', REQ_REL).split('\n').filter(Boolean).pop()
  if (!first) return { warning: `requirements.json is not committed yet, so drift since the freeze cannot be checked.`, changed: false }
  let orig
  try { orig = JSON.parse(execFileSync('git', ['show', `${first}:${REQ_REL}`], { cwd: CWD, encoding: 'utf8' }).replace(/^﻿/, '')) } catch { return { warning: 'the first committed requirements.json is unreadable.', changed: true } }
  const a = new Map((orig.requirements || []).map((r) => [r.id, r]))
  const b = new Map((current.requirements || []).map((r) => [r.id, r]))
  const diffs = []
  for (const [id, r] of a) {
    if (!b.has(id)) diffs.push(`${id} removed`)
    else if (b.get(id).text !== r.text || b.get(id).origin !== r.origin) diffs.push(`${id} changed`)
  }
  for (const id of b.keys()) if (!a.has(id)) diffs.push(`${id} added`)
  if (orig.source !== current.source) diffs.push('source changed')
  if (!diffs.length) return { warning: null, changed: false }
  return { changed: true, warning: `requirements.json changed after it was frozen (first committed in ${first.slice(0, 7)}): ${diffs.join(', ')}. Only a human breakpoint may edit it.` }
}

// ── markdown helpers ─────────────────────────────────────────────────────────
const cell = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
function proofCell(p) {
  if (!p) return '—'
  const art = p.artifact ? ` · [${/trace/i.test(p.artifact) ? 'trace' : 'artifact'}](${p.artifact})` : ''
  if (p.type === 'test' || p.type === 'e2e') return `\`${p.file}\` › "${p.name}"${art}`
  if (p.type === 'command') return `\`${Array.isArray(p.run) ? p.run.join(' ') : String(p.run ?? '')}\`${p.expectStdout ? ` → \`${p.expectStdout}\`` : ''}`
  if (p.type === 'manual') return 'manual'
  if (p.type === 'skip') return 'skipped'
  return `unknown type "${p.type}"`
}
function originCell(o) { return o === 'plan' ? 'plan (agent-added)' : o || '—' }

function render({ req, rows, totals, ci, dr, branchNote, openItems, verifierNote }) {
  const L = []
  L.push('## Evidence')
  L.push(`> Requirements frozen at plan approval (${req.source}, ${req.frozenAt}). Status computed by forge-evidence, not by the agent.`)
  if (dr.warning) L.push('>', `> ⚠️ **${dr.warning}**`)
  if (branchNote) L.push('>', `> ⚠️ **${branchNote}**`)
  if (verifierNote) L.push('>', `> ${verifierNote}`)
  L.push('')
  L.push('| # | Requirement | Origin | Proof | Strength | Status |')
  L.push('|---|---|---|---|---|---|')
  for (const r of rows) {
    const status = ICON[r.status] + (r.note && r.status !== 'pass' ? `: ${r.note}` : '')
    L.push(`| ${cell(r.id)} | ${cell(r.text)} | ${cell(originCell(r.origin))} | ${cell(proofCell(r.proof))} | ${cell(r.strength.length ? r.strength.join(' · ') : '—')} | ${cell(status)} |`)
  }
  L.push('')
  L.push(`**Totals:** ${totals.pass} ✅ · ${totals.fail} ❌ · ${totals.open} ⚠️ · ${totals.skipped} ⏭  ·  **CI on PR head:** ${ci.line}`)

  const decDir = ['docs/decisions', 'docs/adr'].find((d) => fs.existsSync(path.join(CWD, d)))
  if (decDir) {
    const added = MERGE_BASE ? git('diff', '--name-only', '--diff-filter=A', `${MERGE_BASE}...HEAD`, '--', decDir).split('\n').filter(Boolean) : []
    L.push('', '### Decisions')
    const ids = Array.isArray(req.decisions) ? req.decisions : []
    L.push(ids.length ? `Relied on (from the plan): ${ids.map((d) => `\`${d}\``).join(', ')}` : 'Relied on (from the plan): none recorded')
    L.push(added.length ? `Added on this branch: ${added.map((f) => `\`${f}\``).join(', ')}` : 'Added on this branch: none')
  }

  L.push('', '### Not covered by this PR')
  const gapsFile = path.join(DIR, 'gaps.md')
  const notPass = rows.filter((r) => r.status !== 'pass')
  if (fs.existsSync(gapsFile)) L.push(readText(gapsFile).replace(/\r\n/g, '\n').trim())
  else if (notPass.length) for (const r of notPass) L.push(`- ${r.id} — ${ICON[r.status]}${r.note ? `: ${r.note}` : ''}`)
  else L.push('Nothing: every frozen requirement has a passing proof.')

  L.push('', '### Owner actions')
  const ownerFile = path.join(DIR, 'owner-actions.md')
  if (fs.existsSync(ownerFile)) L.push(readText(ownerFile).replace(/\r\n/g, '\n').trim())
  const migrations = MERGE_BASE ? git('diff', '--name-only', '--diff-filter=A', `${MERGE_BASE}...HEAD`, '--', 'supabase/migrations').split('\n').filter(Boolean) : []
  if (migrations.length) L.push('⚠️ **Supabase Migration Required** (not applied; human-gated):', ...migrations.map((f) => `- \`${f}\``))
  else if (!fs.existsSync(ownerFile)) L.push('No Supabase action needed for this branch.')

  L.push('', '### Open items')
  if (openItems.length) for (const o of openItems) L.push(`- [ ] ${o}`)
  else L.push('None.')
  return L.join('\n')
}

// ── insert into the repo's own PR template (never replace it) ────────────────
function findTemplate() {
  const given = arg('--body', null) || arg('--template', null)
  if (given) return path.resolve(CWD, given)
  for (const c of ['.github/PULL_REQUEST_TEMPLATE.md', '.github/pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/PULL_REQUEST_TEMPLATE.md']) {
    if (fs.existsSync(path.join(CWD, c))) return path.join(CWD, c)
  }
  return null
}
function shiftHeadings(md, by) {
  return md.split('\n').map((l) => l.replace(/^(#{1,6})(\s)/, (_, h, s) => '#'.repeat(Math.min(6, h.length + by)) + s)).join('\n')
}
function mergeIntoTemplate(template, section) {
  const ls = lines(template)
  const block = (body) => [START, body, END]
  // A previous run's block: replace it in place.
  const s = ls.indexOf(START)
  const e = ls.indexOf(END)
  if (s >= 0 && e > s) {
    // A standalone block starts with its own "## Evidence"; a filled one sits under the repo's heading.
    const standalone = /^#{1,6}\s+Evidence\b/.test(ls[s + 1] || '')
    const prevHeading = !standalone && s > 0 && /^#{1,6}\s/.test(ls[s - 1]) ? ls[s - 1] : null
    const lvl = prevHeading ? prevHeading.match(/^#+/)[0].length : 0
    const body = lvl ? shiftHeadings(section.split('\n').slice(1).join('\n'), lvl - 2) : section
    return [...ls.slice(0, s), ...block(body), ...ls.slice(e + 1)].join('\n')
  }
  const heads = ls.map((l, i) => ({ i, m: l.match(/^(#{1,6})\s+(.*)$/) })).filter((h) => h.m)
  const target = heads.find((h) => /\bevidence\b/i.test(h.m[2])) ||
    heads.find((h) => /^(tests?|testing|test plan|how (was this|to) test(ed)?|verification|validation)\b/i.test(h.m[2].trim()))
  if (target) {
    // Fill the repo's own section: keep its heading and its own body, put ours right under the heading.
    const lvl = target.m[1].length
    const body = shiftHeadings(section.split('\n').slice(1).join('\n'), lvl - 2).replace(/^\n+/, '')
    return [...ls.slice(0, target.i + 1), ...block(body), ...ls.slice(target.i + 1)].join('\n')
  }
  if (!heads.length) return [...ls, '', ...block(section)].join('\n')
  // No Evidence/Test section: insert ours after the first section, before the second heading.
  const next = heads[1] ? heads[1].i : ls.length
  return [...ls.slice(0, next), ...block(section), '', ...ls.slice(next)].join('\n')
}

// ── report ───────────────────────────────────────────────────────────────────
function report() {
  fs.mkdirSync(DIR, { recursive: true })
  let req
  try { req = readJson(REQ_FILE) } catch {
    const msg = `## Evidence\n> ⚠️ No frozen requirements (${REQ_REL} missing or unreadable). Nothing was graded.\n`
    fs.writeFileSync(path.join(DIR, 'evidence.md'), msg)
    fs.writeFileSync(path.join(DIR, 'evidence.result.json'), JSON.stringify({ error: 'no requirements.json', counts: { pass: 0, fail: 0, open: 0, skipped: 0 } }, null, 2) + '\n')
    console.log(msg)
    return
  }
  let evidence = {}
  try { evidence = readJson(path.join(DIR, 'evidence.json')) } catch { /* every row becomes open */ }

  const head = git('rev-parse', 'HEAD')
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  const pinned = arg('--branch', null)
  const branchNote = pinned && pinned !== branch ? `Branch mismatch: HEAD is on \`${branch}\`, not the working branch \`${pinned}\`. Nothing was run; every row is open.` : null

  let skippedMd = ''
  try { skippedMd = readText(path.join(CWD, 'SKIPPED.md')) } catch { /* none */ }
  const verifier = branchNote ? null : repoVerifier()
  const verifierNote = verifier && verifier.map ? 'Statuses taken from the repo\'s own `npm run verify:acceptance` report.'
    : verifier && verifier.error ? `Repo verifier ignored: ${verifier.error}; proofs were re-run one by one.` : null

  const rows = (req.requirements || []).map((r) => {
    const proof = evidence[r.id] && typeof evidence[r.id] === 'object' ? { ...evidence[r.id] } : null
    // The agent declares WHERE the proof is. Any status it wrote is discarded unread.
    if (proof) { delete proof.status; delete proof.result; delete proof.passed }
    const row = { id: r.id, text: r.text, origin: r.origin, proof, strength: [], status: 'open', note: '' }
    if (branchNote) { row.note = 'branch mismatch'; return row }
    if (!proof) { row.note = 'no proof declared'; return row }
    if (proof.type === 'test' || proof.type === 'e2e') row.strength = strengthOf(proof)
    else if (proof.type === 'command') row.strength = ['command']

    let res
    if (verifier && verifier.map && proof.type !== 'manual' && proof.type !== 'skip') {
      res = verifier.map.get(r.id) || { status: 'open', note: 'not in the repo verifier report' }
    } else if (proof.type === 'test' || proof.type === 'e2e') res = runNamedTest(proof)
    else if (proof.type === 'command') res = runCommand(proof)
    else if (proof.type === 'manual') res = { status: 'open', note: proof.reason || 'manual proof, no reason given' }
    else if (proof.type === 'skip') {
      res = !proof.reason ? { status: 'open', note: 'skip declared without a reason' }
        : !new RegExp(`\\b${escapeRe(r.id)}\\b`).test(skippedMd) ? { status: 'open', note: `skip not recorded in SKIPPED.md (${proof.reason})` }
        : { status: 'skipped', note: proof.reason }
    } else res = { status: 'open', note: `unknown proof type "${proof.type}"` }
    row.status = res.status
    row.note = res.note || ''
    if (proof.artifact && !reachable(proof.artifact) && row.status !== 'fail') {
      row.status = 'open'
      row.note = `proof not reachable by reviewer (${proof.artifact} is not a URL or a committed file)`
    }
    return row
  })

  const totals = { pass: 0, fail: 0, open: 0, skipped: 0 }
  for (const r of rows) totals[r.status] += 1
  const ci = ciLine(head || 'HEAD')
  const dr = drift(req)
  const openItems = []
  if (!ci.ran) openItems.push(ci.line.replace(/^⛔\s*/, ''))
  if (dr.changed) openItems.push(dr.warning)
  if (branchNote) openItems.push(branchNote)
  for (const r of rows) if (r.status === 'open' || r.status === 'fail') openItems.push(`${r.id} ${ICON[r.status]}: ${r.note}`)

  const section = render({ req, rows, totals, ci, dr, branchNote, openItems, verifierNote })
  const tpl = findTemplate()
  const body = tpl && fs.existsSync(tpl) ? mergeIntoTemplate(readText(tpl), section) : [START, section, END].join('\n')
  fs.writeFileSync(path.join(DIR, 'evidence.md'), section + '\n')
  fs.writeFileSync(path.join(DIR, 'pr-body.md'), body.replace(/\n*$/, '\n'))
  fs.writeFileSync(path.join(DIR, 'evidence.result.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    branch, head, pinnedBranch: pinned, branchMismatch: !!branchNote,
    source: req.source, frozenAt: req.frozenAt,
    counts: totals,
    ci: { ran: ci.ran, line: ci.line },
    drift: dr.changed ? dr.warning : null,
    rows: rows.map(({ id, origin, status, note, strength }) => ({ id, origin, status, note, strength })),
    openItems,
    template: tpl ? posix(path.relative(CWD, tpl)) : null,
  }, null, 2) + '\n')
  console.log(section)
}

if (SUB === 'freeze') process.exitCode = freeze()
else if (SUB === 'report') {
  // Reports, never blocks: any internal error still exits 0 with the error on stderr.
  try { report() } catch (e) {
    // Never leave a previous run's result on disk looking current.
    const msg = `## Evidence\n> ⚠️ forge-evidence failed before grading: ${String(e && e.message ? e.message : e).split('\n')[0]}. Nothing was graded.\n`
    try {
      fs.mkdirSync(DIR, { recursive: true })
      fs.writeFileSync(path.join(DIR, 'evidence.md'), msg)
      fs.writeFileSync(path.join(DIR, 'evidence.result.json'), JSON.stringify({ error: String(e && e.message ? e.message : e), counts: { pass: 0, fail: 0, open: 0, skipped: 0 } }, null, 2) + '\n')
    } catch { /* nothing more we can do */ }
    console.error(`[forge-evidence] report failed: ${e && e.stack ? e.stack : e}`)
  }
  process.exitCode = 0
} else {
  console.error(`[forge-evidence] unknown subcommand "${SUB}" (want: freeze | report)`)
  process.exitCode = 0
}
