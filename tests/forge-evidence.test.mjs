// scripts/forge-evidence.mjs against throwaway git repos. The script, not the agent, grades:
// a missing proof is open, an agent-written status is ignored, proofs are re-run with
// shell: false, and strength labels come from the fixture's own git history.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'forge-evidence.mjs')
const NODE = process.execPath
let tmp, repo

const w = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text) }
const crlf = (s) => s.replace(/\r?\n/g, '\r\n')
function gitIn(dir) { return (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }) }
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const g = gitIn(dir)
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'core.autocrlf', 'false')
  return g
}
const REQS = {
  frozenAt: '2026-11-01T00:00:00.000Z', frozenCommit: null, source: 'task-prompt',
  requirements: [
    { id: 'R1', text: 'expired tokens are rejected', origin: 'prompt' },
    { id: 'R2', text: 'members are denied', origin: 'prompt' },
    { id: 'R3', text: 'an agent-added extra', origin: 'plan' },
  ],
}
const passing = (name) => `import { test } from 'node:test'\ntest(${JSON.stringify(name)}, () => {})\n`

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-evidence-test-'))
  repo = path.join(tmp, 'repo')
  const g = initRepo(repo)
  w(repo, 'package.json', JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }, null, 2))
  w(repo, 'tests/old.test.mjs', passing('old works'))
  w(repo, 'src/a.js', 'export const a = 1\n')
  g('add', '.'); g('commit', '-qm', 'init')
  g('checkout', '-qb', 'feat/x')
  // Commit 1: the freeze and a test written BEFORE any implementation (true TDD).
  w(repo, '.a5c/forge/requirements.json', JSON.stringify(REQS, null, 2))
  w(repo, 'tests/frozen.test.mjs', passing('frozen ok') +
    '// @mutation-verified\n//   test: "frozen ok"\n//   mutated src/impl.js return value, watched it fail, restored.\n')
  g('add', '.'); g('commit', '-qm', 'test: freeze + tdd test')
  // Commit 2: the implementation.
  w(repo, 'src/impl.js', 'export const impl = () => 1\n')
  g('add', '.'); g('commit', '-qm', 'feat: impl')
  // Commit 3: a test written after the implementation, with an undeclared jest.mock.
  w(repo, 'tests/after.test.mjs',
    "import { test } from 'node:test'\n// jest.mock('../src/impl.js')\n" +
    "test('after ok', () => {})\ntest('after fails', () => { throw new Error('nope') })\n")
  w(repo, 'proof/trace.zip', 'zip')
  g('add', '.'); g('commit', '-qm', 'test: after')
})
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

function report(dir, evidence, ...extra) {
  fs.rmSync(path.join(dir, '.a5c/forge/evidence.result.json'), { force: true })
  if (evidence !== undefined) w(dir, '.a5c/forge/evidence.json', typeof evidence === 'string' ? evidence : JSON.stringify(evidence))
  const out = execFileSync(NODE, [SCRIPT, 'report', '--cwd', dir, '--base', 'main', ...(extra.includes('--ci-checks') ? [] : ['--no-ci']), ...extra], { encoding: 'utf8' })
  const res = JSON.parse(fs.readFileSync(path.join(dir, '.a5c/forge/evidence.result.json'), 'utf8'))
  const md = fs.readFileSync(path.join(dir, '.a5c/forge/evidence.md'), 'utf8')
  return { out, res, md, row: (id) => res.rows.find((r) => r.id === id) }
}

test('a requirement with no evidence entry is open and still listed; an agent-written status is ignored', () => {
  const { res, md, row } = report(repo, {
    R1: { type: 'test', file: 'tests/after.test.mjs', name: 'after fails', status: 'pass', passed: true },
  })
  assert.equal(row('R1').status, 'fail', 'the agent said pass; the re-run says fail')
  assert.equal(row('R2').status, 'open')
  assert.equal(row('R2').note, 'no proof declared')
  assert.equal(res.rows.length, 3, 'nothing is dropped')
  assert.match(md, /\| R2 \| members are denied \| prompt \| — \| — \| ⚠️ open: no proof declared \|/)
  assert.match(md, /\| R3 \| an agent-added extra \| plan \(agent-added\) \|/)
  assert.deepEqual(res.counts, { pass: 0, fail: 1, open: 2, skipped: 0 })
})

test('a passing named test is ✅, a failing one ❌, a name matching nothing ⚠️', () => {
  const { row } = report(repo, {
    R1: { type: 'test', file: 'tests/frozen.test.mjs', name: 'frozen ok' },
    R2: { type: 'test', file: 'tests/after.test.mjs', name: 'after fails' },
    R3: { type: 'test', file: 'tests/after.test.mjs', name: 'no such test' },
  })
  assert.equal(row('R1').status, 'pass')
  assert.equal(row('R2').status, 'fail')
  assert.equal(row('R3').status, 'open')
  assert.match(row('R3').note, /matched 0 tests/)
})

test('an unknown runner is open: runner not detected', () => {
  const dir = path.join(tmp, 'norunner')
  const g = initRepo(dir)
  w(dir, 'package.json', JSON.stringify({ scripts: { test: 'echo none' } }))
  w(dir, 'tests/x.test.mjs', passing('x'))
  w(dir, '.a5c/forge/requirements.json', JSON.stringify({ ...REQS, requirements: [REQS.requirements[0]] }))
  g('add', '.'); g('commit', '-qm', 'init')
  const { row } = report(dir, { R1: { type: 'test', file: 'tests/x.test.mjs', name: 'x' } })
  assert.equal(row('R1').status, 'open')
  assert.equal(row('R1').note, 'runner not detected')
})

test('command proofs: exit + stdout regex match ✅, mismatches ❌, run with shell: false and no pipes', () => {
  const { row } = report(repo, {
    R1: { type: 'command', run: [NODE, '-e', 'console.log("found 0 violations")'], expectExit: 0, expectStdout: '0 violations' },
    R2: { type: 'command', run: [NODE, '-e', 'process.exit(3)'], expectExit: 0 },
    R3: { type: 'command', run: [NODE, '-e', 'console.log("2 violations")'], expectStdout: '^0 violations' },
  })
  assert.equal(row('R1').status, 'pass')
  assert.equal(row('R2').status, 'fail')
  assert.match(row('R2').note, /exit 3, expected 0/)
  assert.equal(row('R3').status, 'fail')

  // A `|` is a literal argument, not a pipe: with shell: false nothing downstream runs.
  const piped = report(repo, {
    R1: { type: 'command', run: [NODE, '-e', 'console.log(process.argv.slice(1).join(","))', '|', 'grep', 'x'], expectStdout: '^\\|,grep,x$' },
    R2: { type: 'command', run: 'node -e 1 | grep x' },
  })
  assert.equal(piped.row('R1').status, 'pass', 'the pipe arrived as literal argv')
  assert.equal(piped.row('R2').status, 'open', 'a shell string is refused')
  assert.match(piped.row('R2').note, /argv array/)
})

test('strength labels come from git history and source', () => {
  w(repo, 'tests/scratch.test.mjs', passing('scratch'))
  try {
    const { row, md } = report(repo, {
      R1: { type: 'test', file: 'tests/frozen.test.mjs', name: 'frozen ok' },
      R2: { type: 'test', file: 'tests/after.test.mjs', name: 'after ok' },
      R3: { type: 'test', file: 'tests/old.test.mjs', name: 'old works', mocked: true },
    })
    assert.deepEqual(row('R1').strength, ['frozen before impl', 'mutation-verified'])
    assert.deepEqual(row('R2').strength, ['mocked?', 'new test'], 'undeclared jest.mock is flagged')
    assert.deepEqual(row('R3').strength, ['mocked', 'pre-existing'])
    assert.match(md, /frozen before impl · mutation-verified \| ✅ pass/)
    const unc = report(repo, { R1: { type: 'test', file: 'tests/scratch.test.mjs', name: 'scratch' } })
    assert.deepEqual(unc.row('R1').strength, ['uncommitted'])
  } finally { fs.rmSync(path.join(repo, 'tests/scratch.test.mjs')) }
})

test('mutation-verified needs a block naming THAT test', () => {
  const { row } = report(repo, { R1: { type: 'test', file: 'tests/after.test.mjs', name: 'after ok' } })
  assert.ok(!row('R1').strength.includes('mutation-verified'))
})

test('a local test-results/ artifact is open: not reachable; a URL or committed file is fine', () => {
  const { row } = report(repo, {
    R1: { type: 'test', file: 'tests/frozen.test.mjs', name: 'frozen ok', artifact: 'test-results/login/trace.zip' },
    R2: { type: 'test', file: 'tests/frozen.test.mjs', name: 'frozen ok', artifact: 'https://ci.example.com/run/1/trace.zip' },
    R3: { type: 'test', file: 'tests/frozen.test.mjs', name: 'frozen ok', artifact: 'proof/trace.zip' },
  })
  assert.equal(row('R1').status, 'open')
  assert.match(row('R1').note, /not reachable by reviewer/)
  assert.equal(row('R2').status, 'pass')
  assert.equal(row('R3').status, 'pass')
})

test('no CI on the PR head: the ⛔ line plus an Open item; CI that ran is summarised', () => {
  w(repo, '.a5c/ci-none.json', JSON.stringify({ total_count: 0, check_runs: [] }))
  w(repo, '.a5c/ci-ran.json', JSON.stringify({ check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }] }))
  const none = report(repo, {}, '--ci-checks', '.a5c/ci-none.json')
  assert.equal(none.res.ci.ran, false)
  assert.match(none.md, /\*\*CI on PR head:\*\* ⛔ CI did not run on this PR's head commit/)
  assert.ok(none.res.openItems.some((o) => /CI did not run/.test(o)))
  assert.match(none.md, /### Open items\n(- \[ \] .*\n)*- \[ \] CI did not run/)
  const ran = report(repo, {}, '--ci-checks', '.a5c/ci-ran.json')
  assert.equal(ran.res.ci.ran, true)
  assert.match(ran.res.ci.line, /2 check run\(s\) on [0-9a-f]{7}: 1 ✅ · 1 ❌/)
  assert.ok(!ran.res.openItems.some((o) => /CI did not run/.test(o)))
})

test('requirements.json edited after its first commit prints the drift warning', () => {
  const p = path.join(repo, '.a5c/forge/requirements.json')
  const orig = fs.readFileSync(p, 'utf8')
  assert.equal(report(repo, {}).res.drift, null, 'unchanged file: no warning')
  try {
    const edited = JSON.parse(orig)
    edited.requirements[1].text = 'members are denied, mostly'
    edited.requirements.push({ id: 'R4', text: 'snuck in', origin: 'plan' })
    fs.writeFileSync(p, JSON.stringify(edited))
    const { res, md } = report(repo, {})
    assert.match(res.drift, /changed after it was frozen \(first committed in [0-9a-f]{7}\): R2 changed, R4 added/)
    assert.match(md.split('|')[0], /⚠️ \*\*requirements\.json changed after it was frozen/, 'warning sits above the table')
  } finally { fs.writeFileSync(p, orig) }
})

test('a branch mismatch runs nothing and forces every row open', () => {
  const { res } = report(repo, { R1: { type: 'test', file: 'tests/frozen.test.mjs', name: 'frozen ok' } }, '--branch', 'feat/other')
  assert.equal(res.branchMismatch, true)
  assert.ok(res.rows.every((r) => r.status === 'open' && r.note === 'branch mismatch'))
})

test('a skip counts as ⏭ only with a reason AND a SKIPPED.md entry; manual is open', () => {
  w(repo, 'SKIPPED.md', '# Skipped\n\n## Open items\n- [ ] R1: no staging billing account\n')
  try {
    const { row, res } = report(repo, {
      R1: { type: 'skip', reason: 'no staging billing account' },
      R2: { type: 'skip', reason: 'later' },
      R3: { type: 'manual', reason: 'needs a production billing toggle' },
    })
    assert.equal(row('R1').status, 'skipped')
    assert.equal(row('R2').status, 'open')
    assert.match(row('R2').note, /not recorded in SKIPPED\.md/)
    assert.equal(row('R3').status, 'open')
    assert.equal(row('R3').note, 'needs a production billing toggle')
    assert.deepEqual(res.counts, { pass: 0, fail: 0, open: 2, skipped: 1 })
  } finally { fs.rmSync(path.join(repo, 'SKIPPED.md')) }
})

test("the repo's PR template is preserved; Evidence is inserted after the first section", () => {
  const tpl = '## Summary\n<!-- what and why -->\n\n## Safety checklist\n- [ ] RLS reviewed\n\n## Owner instructions\nDo not merge on Fridays.\n'
  w(repo, '.github/PULL_REQUEST_TEMPLATE.md', tpl)
  try {
    report(repo, {})
    const body = fs.readFileSync(path.join(repo, '.a5c/forge/pr-body.md'), 'utf8')
    const at = (s) => body.indexOf(s)
    for (const s of ['## Summary', '<!-- what and why -->', '## Safety checklist', '- [ ] RLS reviewed', '## Owner instructions', 'Do not merge on Fridays.']) {
      assert.ok(at(s) >= 0, `template line kept: ${s}`)
    }
    assert.ok(at('## Summary') < at('## Evidence') && at('## Evidence') < at('## Safety checklist') &&
      at('## Safety checklist') < at('## Owner instructions'), 'repo sections in order, Evidence after the first')
    // A re-run replaces the block rather than stacking a second one.
    w(repo, '.a5c/forge/body.md', body)
    report(repo, {}, '--body', '.a5c/forge/body.md')
    const again = fs.readFileSync(path.join(repo, '.a5c/forge/pr-body.md'), 'utf8')
    assert.equal(again.split('<!-- forge-evidence:start -->').length, 2)
    assert.equal(again.split('## Evidence').length, 2)
  } finally { fs.rmSync(path.join(repo, '.github'), { recursive: true }) }
})

test("the repo's own Testing section is filled under its own heading", () => {
  w(repo, '.github/pull_request_template.md', '# PR\n\n## Testing\n<!-- how did you test -->\n\n## Rollback\nRevert the merge.\n')
  try {
    report(repo, {})
    const body = fs.readFileSync(path.join(repo, '.a5c/forge/pr-body.md'), 'utf8')
    assert.ok(!body.includes('## Evidence'), 'no second Evidence heading')
    const t = body.indexOf('## Testing')
    assert.ok(t >= 0 && body.indexOf('| # | Requirement |') > t && body.indexOf('| # | Requirement |') < body.indexOf('## Rollback'))
    assert.ok(body.includes('<!-- how did you test -->') && body.includes('Revert the merge.'))
    assert.match(body, /### Not covered by this PR/, 'subsections nested one level under ## Testing')
    w(repo, '.a5c/forge/body.md', body)
    report(repo, {}, '--body', '.a5c/forge/body.md')
    const again = fs.readFileSync(path.join(repo, '.a5c/forge/pr-body.md'), 'utf8')
    assert.equal(again, body, 'idempotent re-run')
  } finally { fs.rmSync(path.join(repo, '.github'), { recursive: true }) }
})

test('Windows CRLF inputs parse: requirements, evidence, template, mutation block and freeze', () => {
  const dir = path.join(tmp, 'crlf')
  const g = initRepo(dir)
  w(dir, 'package.json', crlf(JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }, null, 2)))
  w(dir, 'prompt.md', crlf('# Task\n\n## Definition of Done\n- [ ] first thing\n- second thing\n  wraps here\n\n## Notes\n- not a requirement\n'))
  w(dir, '.github/PULL_REQUEST_TEMPLATE.md', crlf('## Summary\ntext\n\n## Checklist\n- [ ] done\n'))
  g('add', '.'); g('commit', '-qm', 'init')
  g('checkout', '-qb', 'feat/crlf')
  execFileSync(NODE, [SCRIPT, 'freeze', '--cwd', dir, '--prompt-file', 'prompt.md'], { encoding: 'utf8' })
  const req = JSON.parse(fs.readFileSync(path.join(dir, '.a5c/forge/requirements.json'), 'utf8'))
  assert.deepEqual(req.requirements.map((r) => r.text), ['first thing', 'second thing wraps here'])
  // Re-save every input with CRLF, as a Windows checkout would.
  w(dir, '.a5c/forge/requirements.json', crlf(JSON.stringify(req, null, 2)))
  w(dir, 'tests/c.test.mjs', crlf(passing('crlf ok') + '// @mutation-verified\n//   "crlf ok" — flipped the assertion, saw red.\n'))
  g('add', '.'); g('commit', '-qm', 'test + freeze')
  const { row, res } = report(dir, crlf(JSON.stringify({ R1: { type: 'test', file: 'tests/c.test.mjs', name: 'crlf ok' } }, null, 2)))
  assert.equal(row('R1').status, 'pass')
  assert.deepEqual(row('R1').strength, ['frozen before impl', 'mutation-verified'])
  assert.equal(res.drift, null)
  const body = fs.readFileSync(path.join(dir, '.a5c/forge/pr-body.md'), 'utf8')
  assert.ok(!body.includes('\r'))
  assert.ok(body.indexOf('## Summary') < body.indexOf('## Evidence') && body.indexOf('## Evidence') < body.indexOf('## Checklist'))
})

test('freeze: acceptance spec ids verbatim, plan additions tagged, no silent overwrite', () => {
  const dir = path.join(tmp, 'spec')
  const g = initRepo(dir)
  w(dir, 'acceptance/login.acceptance.json', JSON.stringify({ requirements: [{ id: 'AC-7', text: 'rejects expired token' }, { id: 'AC-9', description: 'member is denied' }] }))
  w(dir, 'plan.md', '- add an audit log line\n')
  g('add', '.'); g('commit', '-qm', 'init')
  const freeze = (...a) => { try { return { code: 0, out: execFileSync(NODE, [SCRIPT, 'freeze', '--cwd', dir, ...a], { encoding: 'utf8', stdio: 'pipe' }) } } catch (e) { return { code: e.status, out: String(e.stderr) } } }
  const first = freeze('--plan-file', 'plan.md')
  assert.equal(first.code, 0)
  assert.match(first.out, /AC-7 \[spec\] rejects expired token/)
  assert.match(first.out, /R3 \[plan, agent-added\] add an audit log line/)
  const req = JSON.parse(fs.readFileSync(path.join(dir, '.a5c/forge/requirements.json'), 'utf8'))
  assert.equal(req.source, 'acceptance-spec')
  assert.deepEqual(req.requirements.map((r) => [r.id, r.origin]), [['AC-7', 'spec'], ['AC-9', 'spec'], ['R3', 'plan']])
  assert.match(req.frozenCommit, /^[0-9a-f]{40}$/)
  const again = freeze()
  assert.equal(again.code, 1)
  assert.match(again.out, /already frozen/)
})

test('report never blocks: exit 0 even with no requirements.json', () => {
  const dir = path.join(tmp, 'empty')
  initRepo(dir)
  execFileSync(NODE, [SCRIPT, '--cwd', dir, '--no-ci'], { encoding: 'utf8' })
  assert.match(fs.readFileSync(path.join(dir, '.a5c/forge/evidence.md'), 'utf8'), /No frozen requirements/)
})

test('jest, vitest and playwright are invoked through their own bin with the right name filter, shell-free', () => {
  // Stand-in runner packages: each bin records its argv and prints the runner's summary line.
  // This checks detection, bin resolution and argv shape without a network install.
  const dir = path.join(tmp, 'runners')
  const g = initRepo(dir)
  const fake = (pkg, bin) => {
    w(dir, `node_modules/${pkg}/package.json`, JSON.stringify({ name: pkg, bin: { [bin]: 'cli.js' } }))
    w(dir, `node_modules/${pkg}/cli.js`,
      "const fs = require('fs'); const a = process.argv.slice(2);\n" +
      `fs.appendFileSync(${JSON.stringify(path.join(dir, 'argv.log'))}, ${JSON.stringify(bin)} + ' ' + JSON.stringify(a) + '\\n');\n` +
      "const pat = new RegExp(a[a.indexOf(a.includes('-g') ? '-g' : '-t') + 1]);\n" +
      "if (pat.test('fails here')) { console.error('Tests: 1 failed'); process.exit(1) }\n" +
      "console.log(pat.test('works (v2)') ? 'Tests:       1 passed, 2 skipped' : 'Tests:       3 skipped')\n")
  }
  fake('jest', 'jest'); fake('vitest', 'vitest'); fake('@playwright/test', 'playwright')
  w(dir, 'unit.test.js', '// test("works (v2)")\n'); w(dir, 'e2e/login.spec.ts', '// test("works (v2)")\n')
  w(dir, '.a5c/forge/requirements.json', JSON.stringify({ ...REQS }))
  g('add', '.'); g('commit', '-qm', 'init')
  const pj = (devDependencies) => w(dir, 'package.json', JSON.stringify({ devDependencies }))
  const log = () => fs.readFileSync(path.join(dir, 'argv.log'), 'utf8').trim().split('\n').map((l) => { const i = l.indexOf(' '); return [l.slice(0, i), JSON.parse(l.slice(i + 1))] })

  pj({ jest: '*', '@playwright/test': '*' })
  const a = report(dir, {
    R1: { type: 'test', file: 'unit.test.js', name: 'works (v2)' },
    R2: { type: 'e2e', file: 'e2e/login.spec.ts', name: 'works (v2)', artifact: 'https://ci.example.com/trace.zip' },
    R3: { type: 'test', file: 'unit.test.js', name: 'fails here' },
  })
  assert.equal(a.row('R1').status, 'pass')
  assert.equal(a.row('R2').status, 'pass')
  assert.equal(a.row('R3').status, 'fail')
  assert.deepEqual(log().slice(0, 2), [
    ['jest', ['unit.test.js', '-t', 'works \\(v2\\)']],
    ['playwright', ['test', 'e2e/login.spec.ts', '-g', 'works \\(v2\\)']],
  ], 'names are regex-escaped and passed as single argv entries')

  fs.rmSync(path.join(dir, 'argv.log'))
  pj({ vitest: '*' })
  const b = report(dir, { R1: { type: 'test', file: 'unit.test.js', name: 'works (v2)' }, R2: { type: 'test', file: 'unit.test.js', name: 'nothing' } })
  assert.equal(b.row('R1').status, 'pass')
  assert.equal(b.row('R2').status, 'open', '"3 skipped" with no pass is not a pass')
  assert.deepEqual(log()[0], ['vitest', ['run', 'unit.test.js', '-t', 'works \\(v2\\)']])

  pj({ jest: '*' }); fs.rmSync(path.join(dir, 'node_modules/jest'), { recursive: true })
  assert.match(report(dir, { R1: { type: 'test', file: 'unit.test.js', name: 'x' } }).row('R1').note, /jest is not installed/)
})
