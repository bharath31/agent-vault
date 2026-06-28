#!/usr/bin/env node
// Open a fresh PR in the testbed repo so the demo is repeatable (merging closes
// the PR). Usage: pnpm seed   (set TESTBED_REPO to use your own repo)
import { execFileSync } from 'node:child_process'

const REPO = process.env.TESTBED_REPO || 'bharath31/nominee-agent-testbed'
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' }).trim()

const sha = JSON.parse(gh(['api', `repos/${REPO}/git/ref/heads/main`])).object.sha
const br = `demo-pr-${Date.now()}`
gh(['api', `repos/${REPO}/git/refs`, '-f', `ref=refs/heads/${br}`, '-f', `sha=${sha}`])
const content = Buffer.from(
  '# Flaky test fix\n\nStabilize retry timing in the integration suite.\n',
).toString('base64')
gh([
  'api',
  `repos/${REPO}/contents/FIX-${br}.md`,
  '-X',
  'PUT',
  '-f',
  'message=Fix flaky integration test',
  '-f',
  `branch=${br}`,
  '-f',
  `content=${content}`,
])
const url = gh([
  'pr',
  'create',
  '--repo',
  REPO,
  '--base',
  'main',
  '--head',
  br,
  '--title',
  'Fix flaky integration test',
  '--body',
  'Demo PR for the nominee github-agent.',
])

const number = url.split('/').pop()
console.log(`\nOpened ${url}`)
console.log(`Try in the agent:  review PR #${number} on ${REPO}\n`)
