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
import { execFileSync } from 'node:child_process'

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

let code = 0
if (SUB === 'freeze') code = freeze()
else {
  console.error(`[forge-evidence] unknown subcommand "${SUB}" (want: freeze | report)`)
}
process.exitCode = code
