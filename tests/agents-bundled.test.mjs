// Every reviewer the arc names must be bundled in agents/, and every bundled
// agent must honour the verdict contract the arc consumes. Zero dependencies.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const AGENT_NAME = /`([a-z]+(?:-[a-z]+)*-(?:reviewer|hunter|cleaner|optimizer))`/g

const bundled = readdirSync(join(ROOT, 'agents'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3))
  .sort()

// Names inside the selectReviewers() block of forge-auto.js (between its
// `// <select-reviewers>` markers): the trivial set, the always-on list and every
// .concat([...]) branch. Only agent-shaped literals count, so mode strings such as
// 'off' are not mistaken for agent names.
function reviewersFromWorkflow() {
  const src = read('workflows/forge-auto.js')
  const m = src.match(/\/\/ <select-reviewers>([\s\S]*?)\/\/ <\/select-reviewers>/)
  assert.ok(m, 'forge-auto.js: `// <select-reviewers>` block not found — parser is stale')
  const names = [...m[1].matchAll(/'([a-z]+(?:-[a-z]+)*-(?:reviewer|hunter|cleaner|optimizer))'/g)].map((x) => x[1])
  return [...new Set(names)]
}

// Section = from the heading containing `PHASE B` to the next heading of equal or
// higher level (fewer or equal `#`).
function section(md, headingTest) {
  const lines = md.split('\n')
  const i = lines.findIndex((l) => /^#{1,6} /.test(l) && headingTest(l))
  if (i === -1) return null
  const level = lines[i].match(/^#+/)[0].length
  let j = i + 1
  while (j < lines.length && !(/^#{1,6} /.test(lines[j]) && lines[j].match(/^#+/)[0].length <= level)) j++
  return lines.slice(i + 1, j).join('\n')
}

function reviewersFromBuildMd() {
  const body = section(read('commands/build.md'), (l) => l.includes('PHASE B'))
  assert.ok(body, 'build.md: no heading containing `PHASE B` — parser is stale')
  return [...new Set([...body.matchAll(AGENT_NAME)].map((m) => m[1]))]
}

function frontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/)
  if (!m) return null
  return Object.fromEntries(
    m[1].split('\n').map((l) => l.match(/^([A-Za-z_]+):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2].trim()]),
  )
}

test('parsers find reviewer names (non-vacuity guard)', () => {
  assert.ok(reviewersFromWorkflow().length >= 1, 'extracted 0 names from forge-auto.js')
  assert.ok(reviewersFromBuildMd().length >= 1, 'extracted 0 names from build.md PHASE B')
})

test('every reviewer forge-auto.js names is bundled', () => {
  const missing = reviewersFromWorkflow().filter((n) => !bundled.includes(n))
  assert.deepEqual(missing, [], `named in forge-auto.js but no agents/<name>.md: ${missing.join(', ')}`)
})

test('every reviewer build.md PHASE B names is bundled', () => {
  const missing = reviewersFromBuildMd().filter((n) => !bundled.includes(n))
  assert.deepEqual(missing, [], `named in build.md PHASE B but no agents/<name>.md: ${missing.join(', ')}`)
})

for (const name of bundled) {
  test(`agents/${name}.md honours the agent contract`, () => {
    const md = read(`agents/${name}.md`)
    const fm = frontmatter(md)
    assert.ok(fm, 'missing YAML frontmatter')
    assert.equal(fm.name, name, 'frontmatter `name` must equal the filename stem')
    assert.ok(fm.description, 'frontmatter `description` must be non-empty')
    assert.ok(fm.tools, 'frontmatter `tools` must be present')
    assert.match(md, /\*\*Severity:\*\*/, 'missing the **Severity:** line')
    const out = md.split('**Output JSON:**')[1]
    assert.ok(out, 'missing the **Output JSON:** block')
    for (const key of ['satisfied', 'findings', 'summary']) {
      assert.ok(out.includes(`"${key}"`), `Output JSON block lacks "${key}"`)
    }
  })
}

test('README "Bundled review agents" lists exactly the files in agents/', () => {
  const body = section(read('README.md'), (l) => /Bundled review agents/.test(l))
  assert.ok(body, 'README: no "Bundled review agents" heading')
  const listed = [...new Set([...body.matchAll(AGENT_NAME)].map((m) => m[1]))].sort()
  assert.deepEqual(listed, bundled)
})
