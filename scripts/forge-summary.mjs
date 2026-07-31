#!/usr/bin/env node
// forge-summary.mjs — end-of-run token/time meter + defensibility verdict + SKIPPED open-items.
//
// Forge's token lever #5: instead of the model hand-tallying usage into prose, this reads the
// authoritative on-disk meter (the Claude Code session transcript JSONL, which records per-turn
// `usage` for the orchestration loop AND every subagent's `subagent_tokens` in its task
// notification) and prints ONE compact, fixed-format summary. Works for both /forge:build
// (babysitter) and /forge:ship (Workflow) because both write agent notifications + main-loop
// turns to the same session transcript. Node-only (needs fs); the /forge command's main loop
// runs it as the final step (a Workflow can't do fs).
//
// Usage:
//   node scripts/forge-summary.mjs [--session <path>] [--base <ref>] [--budget <n>] [--cwd <dir>]
//   --session  explicit transcript JSONL; else the newest .jsonl under the derived project dir
//   --base     git base ref for the changed-file count + SKIPPED 🆕 diff (default: main)
//   --budget   ship's token target (budget.total), for the verdict's spent/budget check
//   --cwd      repo root (default: process.cwd()) — used to derive the transcript dir + git
//
// Output tokens are the headline (matches the statusline `↓ tokens` + Workflow budget.spent()).

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const CWD = path.resolve(arg('--cwd', process.cwd()))
const BASE = arg('--base', 'main')
const BUDGET = Number(arg('--budget', '')) || null

// ── ordered agent-name → phase classifier (edit here to retune grouping) ───────
// First match wins. Keep recon/battery/resolve BEFORE the generic review/implement patterns.
const PHASE_RULES = [
  [/^implement\b|^fix\b/i, 'Implementation'], // "Implement …"/"Fix …" win before generic keyword matches
  [/recon|ground.?truth|find.*surface|match.*presentation|migrations.*i18n|reconnaissance|\bexplore\b|\bsweep\b/i, 'Recon'],
  [/design|blueprint|architect/i, 'Design'],
  [/author.*test|frozen.*test|\btdd\b|test.?author/i, 'Tests (TDD)'],
  [/battery|lens|auditor|api.?security|rls.?audit/i, 'Review battery'],
  [/resolve|apply.*finding|apply.*fix|gate.?fix/i, 'Resolve / fix'],
  [/review|refute|adversar/i, 'Per-step review'],
  [/implement|impl|fix\b|ssrf|wiring|integration|stream|digest|surfaces|inbound|backfill|migration/i, 'Implementation'],
  [/regenerat|database\.ts|gen.?types|pr\b|commit|open.?pr/i, 'Post-processing'],
]
const PHASE_ORDER = ['Recon', 'Design', 'Tests (TDD)', 'Implementation', 'Per-step review', 'Review battery', 'Resolve / fix', 'Post-processing', 'Other']
const phaseOf = (name) => { for (const [re, p] of PHASE_RULES) if (re.test(name)) return p; return 'Other' }

// ── locate the session transcript ──────────────────────────────────────────────
function projectDir(cwd) {
  // Claude Code stores transcripts at ~/.claude/projects/<cwd-with-nonalnum→dashes>/
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-') // each non-alnum → one dash, no collapsing (C:\ → C--)
  return path.join(os.homedir(), '.claude', 'projects', slug)
}
function newestJsonl(dir) {
  if (!fs.existsSync(dir)) return null
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f))
  if (!files.length) return null
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
}
const sessionFile = arg('--session', null) || newestJsonl(projectDir(CWD))
if (!sessionFile || !fs.existsSync(sessionFile)) {
  console.error(`[forge-summary] no session transcript found (looked in ${projectDir(CWD)}). Pass --session <path>.`)
  process.exit(2)
}

// ── parse the transcript ───────────────────────────────────────────────────────
const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : String(n)
let orch = { output: 0, input: 0, cacheRead: 0, turns: 0, firstTs: null, lastTs: null }
const agents = []                 // {name, tokens, ts}
const seen = new Set()            // dedup notifications by ts+tokens (they appear as queue-operation AND user)
const NAME_RES = [/Agent \\"(.+?)\\" finished/, /Agent "(.+?)" finished/, /Agent &quot;(.+?)&quot; finished/]

for (const line of fs.readFileSync(sessionFile, 'utf-8').split('\n')) {
  if (!line.trim()) continue
  let d; try { d = JSON.parse(line) } catch { continue }
  const ts = d.timestamp || null
  if (d.type === 'assistant' && d.message && d.message.usage) {
    const u = d.message.usage
    orch.output += u.output_tokens || 0
    orch.input += u.input_tokens || 0
    orch.cacheRead += u.cache_read_input_tokens || 0
    orch.turns++
    if (ts) { orch.firstTs ||= ts; orch.lastTs = ts }
  }
  const m = line.match(/<usage><subagent_tokens>(\d+)<\/subagent_tokens>/)
  if (m) {
    const tokens = Number(m[1])
    // Each notification is serialized twice (a `queue-operation` + a `user` entry) and one
    // may lack `d.timestamp` — dedup on the stable <task-id> + tokens (a resumed agent that
    // notifies again has a higher token count, so it is legitimately kept).
    const tid = (line.match(/<task-id>([^<]+)<\/task-id>/) || [])[1] || ''
    const key = `${tid}:${tokens}`
    if (seen.has(key)) continue
    seen.add(key)
    let name = 'agent'
    for (const re of NAME_RES) { const nm = line.match(re); if (nm) { name = nm[1]; break } }
    agents.push({ name, tokens, ts })
  }
}

// ── group agents by phase ──────────────────────────────────────────────────────
const byPhase = new Map()
for (const a of agents) {
  const p = phaseOf(a.name)
  if (!byPhase.has(p)) byPhase.set(p, [])
  byPhase.get(p).push(a)
}
const agentTotal = agents.reduce((s, a) => s + a.tokens, 0)
const grandTotal = agentTotal + orch.output

// ── git signals for the verdict + SKIPPED diff ─────────────────────────────────
const git = (cmd) => { try { return execSync(`git ${cmd}`, { cwd: CWD, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } }
let changed = git(`diff --name-only ${BASE}...HEAD`).split('\n').filter(Boolean)
if (!changed.length) changed = git('status --porcelain').split('\n').filter(Boolean).map((l) => l.slice(3))
const changedFiles = changed.length

// ── rule-based verdict ─────────────────────────────────────────────────────────
const ratio = changedFiles ? agents.length / changedFiles : agents.length
let verdict, why
const overBudget = BUDGET && orch.output + agentTotal > BUDGET // best-effort; ship passes real budget.spent via --budget compare upstream
if (changedFiles <= 2 && agents.length >= 15) { verdict = '🔴 RUNAWAY'; why = `${agents.length} agents on a ${changedFiles}-file diff — heavyweight arc on a trivial change (cf. the 5M-on-one-line incident)` }
else if (overBudget) { verdict = '🔴 OVER BUDGET'; why = `~${fmt(grandTotal)} exceeds the ${fmt(BUDGET)} target` }
else if (ratio <= 3) { verdict = '🟢 DEFENSIBLE'; why = `${agents.length} agents vs ${changedFiles} changed files (ratio ${ratio.toFixed(1)}); substantive diff` }
else { verdict = '🟡 HEAVY — justify'; why = `${agents.length} agents vs ${changedFiles} files (ratio ${ratio.toFixed(1)}) — over the 3× rule of thumb but review the diff scope` }

// ── SKIPPED.md open items (+ 🆕 detection via git diff) ─────────────────────────
function skippedOpenItems() {
  const p = path.join(CWD, 'SKIPPED.md')
  if (!fs.existsSync(p)) return { section: false, items: [] }
  // Split on a CRLF-tolerant pattern. On a Windows checkout every line keeps a
  // trailing carriage return, which JS treats as a regex line terminator, so the
  // dot in the checkbox pattern below cannot match it and EVERY item fails to
  // parse. Symptom: the section is found, zero items are collected, and the run
  // summary reports no open items regardless of what SKIPPED.md contains — a
  // silent false-negative on the one section meant to surface unfinished work.
  const lines = fs.readFileSync(p, 'utf-8').split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+Open items/i.test(l))
  if (start < 0) return { section: false, items: [] }
  const items = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break
    const m = lines[i].match(/^\s*[-*]\s*\[( |x|X)\]\s+(.*)$/)
    if (m && m[1] === ' ') items.push(lines[i].trim().replace(/^[-*]\s*\[ \]\s*/, ''))
  }
  const added = git(`diff ${BASE} -- SKIPPED.md`) || git('diff -- SKIPPED.md')
  const addedText = added.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n')
  return { section: true, items: items.map((t) => ({ text: t, isNew: addedText.includes(t.slice(0, 30)) })) }
}
const skipped = skippedOpenItems()

// ── render ─────────────────────────────────────────────────────────────────────
const dur = (orch.firstTs && orch.lastTs) ? Math.round((Date.parse(orch.lastTs) - Date.parse(orch.firstTs)) / 60000) : null
const pad = (s, n) => String(s).padEnd(n)
const padl = (s, n) => String(s).padStart(n)
const L = []
L.push('── Forge run summary ' + '─'.repeat(42))
L.push(pad('Phase / step', 40) + padl('Agents', 8) + padl('Tokens', 12))
L.push('─'.repeat(60))
for (const phase of PHASE_ORDER) {
  const list = byPhase.get(phase)
  if (!list || !list.length) continue
  const sub = list.reduce((s, a) => s + a.tokens, 0)
  L.push(pad(phase, 40) + padl(list.length, 8) + padl('~' + fmt(sub), 12))
  // collapse duplicate step names, sum their tokens
  const steps = new Map()
  for (const a of list) steps.set(a.name, (steps.get(a.name) || 0) + a.tokens)
  for (const [name, tok] of [...steps.entries()].sort((a, b) => b[1] - a[1]))
    L.push(pad('   • ' + name.slice(0, 34), 40) + padl('', 8) + padl('~' + fmt(tok), 12))
}
L.push('─'.repeat(60))
L.push(pad('Orchestration (main loop, ' + orch.turns + ' turns)', 40) + padl('—', 8) + padl(fmt(orch.output), 12))
L.push(pad('TOTAL (output tokens)', 40) + padl('~' + agents.length, 8) + padl(fmt(grandTotal), 12))
L.push('─'.repeat(60))
L.push(`  measured: agents ~${fmt(agentTotal)} + orchestration ${fmt(orch.output)} output${dur != null ? ` · ~${dur >= 60 ? (dur / 60).toFixed(1) + 'h' : dur + 'm'} elapsed (incl. idle waits)` : ''}`)
L.push('')
L.push(`Verdict: ${verdict} — ${why}.`)
L.push('')
if (!skipped.section) {
  L.push('Open items (SKIPPED.md): none parseable — add a `## Open items` section with `- [ ]`')
  L.push('  checkboxes for this to list them.')
} else if (!skipped.items.length) {
  L.push('Open items (SKIPPED.md): none — all boxes checked. ✅')
} else {
  L.push('Open items (SKIPPED.md):')
  for (const it of skipped.items) L.push(`  ${it.isNew ? '🆕' : '  '} [ ] ${it.text}`)
}
L.push('─'.repeat(63))
L.push('~ Best-effort measurement from the session transcript — approximate, informational')
L.push('  only, not for billing. Your provider\'s usage records are authoritative. No warranty.')
console.log(L.join('\n'))
