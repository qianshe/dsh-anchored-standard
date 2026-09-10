import assert from 'node:assert/strict'
import test from 'node:test'

import { apply as applyAnchorTurn, ANCHOR_TEXT } from '../shared/anchor-turn.mjs'
import { apply as applyInstructionHint } from '../shared/instruction-hint.mjs'
import { apply as applyToolBootstrap } from '../shared/tool-bootstrap.mjs'
import { apply as applyZeroToolBootstrap } from '../shared/zero-tool-bootstrap.mjs'

// DeepSeek Harness 0.1.3-alpha.1 removed the public `session.events` array in
// favor of `session.snapshotEvents()` (a frozen copy whose cache is
// invalidated on every append). PR #88 made every history scan prefer
// `snapshotEvents()` and fall back to `session.events`. The rest of the suite
// mocks the legacy shape; these tests run the same core behaviors against
// snapshot-only sessions — no `events` property at all — so the new-harness
// access path is exercised, not just the fallback.

/** A session shaped like dsh 0.1.3: history reachable only via snapshotEvents(). */
function snapshotSession(events, { id = 'snapshot', header = {} } = {}) {
  return {
    id,
    header,
    snapshotEvents() {
      return Object.freeze([...events])
    },
  }
}

function register(applyFn, config = {}) {
  const listeners = {}
  const hookOptions = {}
  const ctx = {
    on(event, callback, options) {
      listeners[event] = callback
      hookOptions[event] = options
    },
    logger: { warn() {} },
  }
  applyFn(ctx, config)
  return { listeners, hookOptions }
}

const assemble = (listener, session, tools) =>
  listener(undefined, { agent: { session } }, async () => ({ system: 'minimal persona', tools }))

// ── tool-bootstrap (base mode): promotion + unlock scans ────────────────────

test('tool-bootstrap: an unpromoted snapshot session exposes the Minimal pair', async () => {
  const { listeners } = register(applyToolBootstrap, { bootstrapTools: ['bash', 'str_replace_editor'] })
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'pwsh' }, { name: 'read' }]
  const result = await assemble(listeners['system-prompt/assemble'], snapshotSession([]), tools)
  assert.deepEqual(result.tools.map((tool) => tool.name), ['bash', 'str_replace_editor'])
})

test('tool-bootstrap: a durable tool call in the snapshot promotes the resident set', async () => {
  const { listeners } = register(applyToolBootstrap, { bootstrapTools: ['bash', 'str_replace_editor'] })
  const tools = [
    { name: 'bash' }, { name: 'str_replace_editor' }, { name: 'dev_tool_search' },
    { name: 'skill_search' }, { name: 'skill_load' }, { name: 'web_search' },
  ]
  const events = [{ type: 'tool/call', data: { name: 'bash' } }]
  const result = await assemble(listeners['system-prompt/assemble'], snapshotSession(events), tools)
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), [
    'bash', 'dev_tool_search', 'skill_load', 'skill_search', 'str_replace_editor',
  ])
})

test('tool-bootstrap: dev_tool_search unlocks recorded in the snapshot stay unlocked', async () => {
  const { listeners } = register(applyToolBootstrap, { bootstrapTools: ['bash', 'str_replace_editor'] })
  const tools = [
    { name: 'bash' }, { name: 'str_replace_editor' }, { name: 'dev_tool_search' },
    { name: 'skill_search' }, { name: 'skill_load' }, { name: 'web_search' },
  ]
  const events = [
    { type: 'assistant/message', data: {} },
    { type: 'tool/call', data: { name: 'dev_tool_search', arguments: '{"toolNames":["web_search"]}' } },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], snapshotSession(events), tools)
  const names = result.tools.map((tool) => tool.name)
  assert.ok(names.includes('web_search'))
})

// ── zero-tool-bootstrap: anchor promotion + compaction re-anchor ────────────

test('zero-tool-bootstrap: the anchor reply in the snapshot promotes the resident catalog', async () => {
  const { listeners } = register(applyZeroToolBootstrap, {})
  const tools = [{ name: 'bash' }, { name: 'str_replace_editor' }, { name: 'dev_tool_search' }, { name: 'read' }]
  const events = [{ type: 'assistant/message', seq: 1, data: {} }]
  const result = await assemble(listeners['system-prompt/assemble'], snapshotSession(events), tools)
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'dev_tool_search', 'str_replace_editor'])
})

test('zero-tool-bootstrap: a compaction boundary in the snapshot re-closes the phase', async () => {
  const { listeners } = register(applyZeroToolBootstrap, { compactionTools: ['read', 'todo_write'] })
  const tools = [{ name: 'bash' }, { name: 'pwsh' }, { name: 'read' }, { name: 'todo_write' }, { name: 'web_search' }]
  const events = [
    { type: 'assistant/message', seq: 1, data: {} },
    { type: 'compaction/end', seq: 2 },
  ]
  const result = await assemble(listeners['system-prompt/assemble'], snapshotSession(events), tools)
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ['bash', 'pwsh', 'read', 'todo_write'])
})

// ── anchor-turn: fresh-session detection ────────────────────────────────────

test('anchor-turn: a snapshot session without user messages is fresh and gets the anchor', () => {
  let listener
  const ctx = {
    on(event, callback) {
      assert.equal(event, 'agent/inbox/inserted')
      listener = callback
    },
  }
  applyAnchorTurn(ctx, {})
  const prepends = []
  const subject = {
    session: snapshotSession([{ type: 'assistant/message', data: {} }], { header: { delegationDepth: 0 } }),
    inbox: { prepend(target, message) { prepends.push({ target, message }) } },
  }
  listener({ agent: subject, message: { source: { kind: 'user' } } })
  assert.equal(prepends.length, 1)
  assert.equal(prepends[0].message.content[0].text, ANCHOR_TEXT)
})

test('anchor-turn: a user message in the snapshot means the session is not fresh', () => {
  let listener
  const ctx = {
    on(event, callback) {
      assert.equal(event, 'agent/inbox/inserted')
      listener = callback
    },
  }
  applyAnchorTurn(ctx, {})
  const prepends = []
  const subject = {
    session: snapshotSession([{ type: 'user/message', data: {} }], { header: { delegationDepth: 0 } }),
    inbox: { prepend(target, message) { prepends.push({ target, message }) } },
  }
  listener({ agent: subject, message: { source: { kind: 'user' } } })
  assert.equal(prepends.length, 0)
})

// ── instruction-hint: durable hint detection across restarts ────────────────

function registerHint() {
  const listeners = {}
  const PROJ_FILES = ['AGENTS.md', 'CLAUDE.md']
  const fs = {
    async resolve(target) { return target },
    async stat(target) {
      const base = target.replace(/\\/g, '/').split('/').pop()
      if (PROJ_FILES.includes(base)) return { type: 'file' }
      if (base === '.git') return { type: 'directory' }
      throw new Error('ENOENT')
    },
  }
  const ctx = {
    on(event, callback) { listeners[event] = callback },
    get(service) { return service === 'fs' ? fs : undefined },
    logger: { warn() {} },
  }
  applyInstructionHint(ctx, { promoteOn: 'either' })
  return { listeners }
}

const decision = () => ({
  kind: 'enter',
  messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
})

test('instruction-hint: a promoted snapshot session gets exactly one hint', async () => {
  const { listeners } = registerHint()
  const agent = {
    session: snapshotSession([{ type: 'assistant/message', seq: 1, data: {} }], { id: 'hint-a', header: { cwd: 'C:/work' } }),
  }
  const first = await listeners['agent/pre-step']({ agent }, async () => decision())
  assert.equal(first.messages.length, 2)
  assert.equal(first.messages[1].source.kind, 'instruction-hint')
  const second = await listeners['agent/pre-step']({ agent }, async () => decision())
  assert.equal(second.messages.length, 1)
})

test('instruction-hint: a durable hint in the snapshot is not re-injected after a restart', async () => {
  const { listeners } = registerHint()
  const agent = {
    session: snapshotSession([
      { type: 'assistant/message', seq: 1, data: {} },
      { type: 'user/message', seq: 2, data: { id: 'instruction-hint-s', content: [], source: { kind: 'instruction-hint' } } },
    ], { id: 'hint-b', header: { cwd: 'C:/work' } }),
  }
  const result = await listeners['agent/pre-step']({ agent }, async () => decision())
  assert.equal(result.messages.length, 1)
})
