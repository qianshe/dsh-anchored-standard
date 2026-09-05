/**
 * sessionEvents compat layer tests.
 *
 * host 0.1.2-rc.1 removed the `Session.events` getter in favor of
 * `snapshotEvents()` / `ownEvents()`. Every phase decision in this preset
 * family reads the durable log through `sessionEvents()`, so these tests pin
 * the resolution order and the degradation contract that keep the presets
 * loadable across host generations:
 *
 *   snapshotEvents() → legacy `events` array → ownEvents() → [] (one warn)
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { createEpochPromotion, sessionEvents } from '../shared/compaction-epoch.mjs'

let nextId = 0
/** host 0.1.2+ session: only the new method surface, no `events` property. */
const newApiSession = (log) => ({
  id: `s-new-${nextId++}`,
  header: {},
  snapshotEvents: () => log,
})

/** host ≤ 0.1.1 session: the legacy getter-shaped property. */
const legacySession = (log) => ({ id: `s-old-${nextId++}`, header: {}, events: log })

test('sessionEvents: prefers snapshotEvents() (host 0.1.2+)', () => {
  const log = [{ type: 'tool/call', seq: 1 }]
  const session = {
    id: 's',
    header: {},
    snapshotEvents: () => log,
    ownEvents: () => [{ type: 'other' }],
  }
  assert.equal(sessionEvents(session), log)
})

test('sessionEvents: falls back to the legacy events array (host ≤ 0.1.1)', () => {
  const log = [{ type: 'user/message', seq: 0 }]
  assert.equal(sessionEvents(legacySession(log)), log)
})

test('sessionEvents: ownEvents() is the fork-aware last resort', () => {
  const own = [{ type: 'tool/call', seq: 2 }]
  const session = { id: 's', header: {}, ownEvents: () => own }
  assert.equal(sessionEvents(session), own)
})

test('sessionEvents: neither API degrades to [] without throwing', () => {
  assert.deepEqual(sessionEvents({ id: 's', header: {} }), [])
})

test('sessionEvents: null/undefined session degrades to []', () => {
  assert.deepEqual(sessionEvents(undefined), [])
  assert.deepEqual(sessionEvents(null), [])
})

test('sessionEvents: a throwing snapshotEvents() degrades to []', () => {
  const session = { id: 's', header: {}, snapshotEvents: () => { throw new Error('boom') } }
  assert.deepEqual(sessionEvents(session), [])
})

test('createEpochPromotion: promotes through a snapshotEvents-only session (host 0.1.2+)', () => {
  const log = [
    { seq: 0, type: 'compaction/end' },
    { seq: 1, type: 'tool/call' },
  ]
  const promotion = createEpochPromotion(['tool/call'])
  assert.equal(promotion.status({ session: newApiSession(log) }).promoted, true)
})

test('createEpochPromotion: pre-boundary signal does not promote (host 0.1.2+)', () => {
  const log = [
    { seq: 0, type: 'tool/call' },
    { seq: 1, type: 'compaction/end' },
  ]
  const promotion = createEpochPromotion(['tool/call'])
  const status = promotion.status({ session: newApiSession(log) })
  assert.equal(status.promoted, false)
  assert.equal(status.boundary, 1)
})

test('createEpochPromotion: legacy sessions keep the old semantics', () => {
  const promotion = createEpochPromotion(['tool/call'])
  assert.equal(promotion.status({ session: legacySession([{ seq: 0, type: 'tool/call' }]) }).promoted, true)
  assert.equal(promotion.status({ session: legacySession([]) }).promoted, false)
})
