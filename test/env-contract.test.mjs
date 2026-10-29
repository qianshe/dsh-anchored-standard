/**
 * env-contract — the once-per-session statement of the two facts a NEW session
 * cannot know: where bash starts, and that `rg` is on PATH.
 *
 * The contract must never reach the anchored first request, must be injected
 * exactly once per session even across restarts, and must not claim `rg` when
 * it is not on PATH.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { apply, contractText, name } from '../shared/env-contract.mjs'

const BIN = process.platform === 'win32' ? 'rg.exe' : 'rg'
const ROOT = mkdtempSync(join(tmpdir(), 'env-contract-'))
test.after(() => rmSync(ROOT, { recursive: true, force: true }))

/** Run a callback with a temporary PATH, restoring it afterwards. */
function withPath(value, run) {
  const previous = process.env.PATH
  process.env.PATH = value
  try {
    return run()
  } finally {
    process.env.PATH = previous
  }
}

/** A PATH directory that contains a fake `rg`. */
function rgDir() {
  const dir = join(ROOT, 'rg-bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, BIN), 'fake')
  return dir
}

/** Register against a fake ctx that keeps every listener. */
function harness(config = {}) {
  const listeners = new Map()
  const ctx = {
    on(event, callback, options) {
      const list = listeners.get(event) ?? []
      list.push({ callback, options })
      listeners.set(event, list)
      return () => {}
    },
    logger: { warn: () => {} },
  }
  apply(ctx, config)
  const preStep = () => {
    const entries = listeners.get('agent/pre-step')
    return entries === undefined ? undefined : entries.at(-1).callback
  }
  return { listeners, preStep }
}

const decision = () => ({ kind: 'enter', messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }] })
const sessionWith = (events, id = 's') => ({ id, events, header: {} })
const promoted = () => sessionWith([{ type: 'assistant/message', seq: 1, data: {} }])

test('plugin identity matches the composition row', () => {
  assert.equal(name, 'env-contract')
})

test('the contract names only what the model cannot know, and claims rg only when it exists', () => {
  const withoutRg = withPath('', () => contractText(undefined, 'linux'))
  assert.match(withoutRg, /workspace root/)
  assert.doesNotMatch(withoutRg, /`rg`/)

  const winContract = withPath('', () => contractText(undefined, 'win32'))
  assert.match(winContract, /defaults to the session workspace root on each call unless workdir is supplied/)
  assert.match(winContract, /relative paths need no leading `cd`/)
  assert.notEqual(winContract, withoutRg)
  for (const platform of ['linux', 'darwin']) {
    const persistent = withPath('', () => contractText(undefined, platform))
    assert.match(persistent, /initially starts in the session workspace root/)
    assert.match(persistent, /later calls retain directory changes made by `cd`/)
    assert.doesNotMatch(persistent, /on (?:every|each) call|need no leading `cd`/)
  }
  assert.equal(withPath('', () => contractText()), process.platform === 'win32' ? winContract : withoutRg)

  const withRg = withPath(rgDir(), () => contractText(undefined, 'linux'))
  assert.ok(withRg.includes('`rg` (ripgrep) is on PATH'), withRg)

  // Rewriting is transparent and an elided result prints its own recall hint,
  // so a standing sentence about the harness would be paid for by every
  // session to teach what the results teach on demand.
  for (const text of [withoutRg, winContract, withRg]) assert.doesNotMatch(text, /rtk/i)

  assert.match(withRg, /Unless progress reports are requested/)
  assert.match(withRg, /necessary questions, blockers, and the final result/)

  // Keep the post-promotion convention compact.
  for (const platform of ['win32', 'linux', 'darwin']) {
    const text = withPath(rgDir(), () => contractText(undefined, platform))
    const words = text.split(/\s+/).filter(Boolean).length
    assert.ok(words <= 80, `${platform} contract grew to ${words} words`)
  }
})

test('pre-promotion requests get no contract', async () => {
  const { preStep } = harness()
  const d = decision()
  const result = await preStep()({ agent: { session: sessionWith([]) } }, async () => d)
  assert.equal(result, d)
})

test('after promotion the contract is injected exactly once per session', async () => {
  const { preStep } = harness()
  const agent = { session: promoted() }
  const first = await preStep()({ agent }, async () => decision())
  assert.equal(first.messages.length, 2)
  const message = first.messages[1]
  assert.equal(message.source.kind, 'env-contract')
  assert.match(message.id, /^env-contract-s-/)
  assert.match(message.content[0].text, /Environment facts for this session/)

  const second = await preStep()({ agent }, async () => decision())
  assert.equal(second.messages.length, 1)
})

test('a durable contract in the log suppresses re-injection after a restart', async () => {
  const { preStep } = harness()
  const agent = {
    session: sessionWith([{ type: 'user/message', seq: 2, data: { source: { kind: 'env-contract' } } }]),
  }
  const result = await preStep()({ agent }, async () => decision())
  assert.equal(result.messages.length, 1)
})

test('a custom text is used verbatim', async () => {
  const { preStep } = harness({ text: 'Custom contract.' })
  const result = await preStep()({ agent: { session: promoted() } }, async () => decision())
  assert.equal(result.messages[1].content[0].text, 'Custom contract.')
})

test('unknown config keys and malformed values are rejected at mount', () => {
  assert.throws(() => harness({ nope: true }), /unknown config key/)
  assert.throws(() => harness({ promoteOn: 'later' }), /promoteOn must be/)
  assert.throws(() => harness({ includeSubagents: 'yes' }), /includeSubagents must be a boolean/)
  assert.throws(() => harness({ text: '   ' }), /text must be a non-empty string/)
})
