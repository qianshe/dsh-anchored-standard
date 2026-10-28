/**
 * rtk-rewrite — unit coverage for the preset's RTK shadow.
 *
 * Everything here runs against fakes: the fake `exec` scripts every
 * `rtk rewrite` exit code (0/3 rewrite, 1/2 pass through, timeout, throw) and
 * the fake `ctx` records what the plugin registers per agent. The one test
 * that needs the real binary is opt-in through `RTK_BIN`.
 */

import assert from 'node:assert/strict'
import { delimiter, join } from 'node:path'
import test from 'node:test'

import { apply, createRewriter, inject, name, resolveRtkPath, shouldRewrite } from '../shared/rtk-rewrite.mjs'

/** A baseline `bash` definition shaped like the preset's shell rows. */
function baseBash() {
  const calls = []
  const definition = {
    name: 'bash',
    description: 'Run commands in a bash shell',
    parameters: {
      command: { type: 'string', required: true, description: 'The bash command to run.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      calls.push(args)
      return `ran:${args.command}`
    },
  }
  return { definition, calls }
}

/** Synchronous fake of `child_process.execFile(file, args, options, cb)`. */
function fakeExec({ code = 0, stdout = '', throwOnCall = false, calls = [] } = {}) {
  return (file, args, options, callback) => {
    calls.push({ file, args, options })
    if (throwOnCall) throw new Error('spawn failed')
    const error = code === 0 ? null : Object.assign(new Error(`exit ${code}`), { code })
    callback(error, stdout)
  }
}

/** Preset-scope context + agent factory that records scoped registrations. */
function harness({ base, tools, exec, rtkPath = '/fake/rtk' } = {}) {
  const registered = []
  const disposed = []
  const warns = []
  const listeners = new Map()
  const ctx = {
    logger: { warn: (message) => warns.push(message) },
    on(event, callback) {
      const list = listeners.get(event) ?? []
      list.push(callback)
      listeners.set(event, list)
      return () => {}
    },
    tools: {
      get: (toolName, agent) => (tools === undefined ? base : tools(toolName, agent)),
    },
  }
  const makeAgent = (id) => {
    const fibers = []
    const agent = {
      id,
      ctx: {
        inject(_services, callback) {
          callback({ tools: { register: (tool) => registered.push(tool) } })
          const fiber = { dispose: () => disposed.push(id) }
          fibers.push(fiber)
          return fiber
        },
      },
    }
    return agent
  }
  const fire = (event, payload) => {
    for (const callback of listeners.get(event) ?? []) callback(payload)
  }
  const start = (config = {}) => apply(ctx, { rtkPath, ...exec === undefined ? {} : { exec }, ...config })
  return { ctx, makeAgent, fire, registered, disposed, warns, start }
}

const agentCall = (tool, args) => tool.execute(args, { signal: new AbortController().signal })

test('plugin identity matches the composition row', () => {
  assert.equal(name, 'rtk-rewrite')
  assert.deepEqual(inject, ['tools'])
})

test('shouldRewrite skips non-strings, blanks, rtk-prefixed and RTK_DISABLED', () => {
  assert.equal(shouldRewrite('git status'), true)
  assert.equal(shouldRewrite('  git status  '), true)
  assert.equal(shouldRewrite(undefined), false)
  assert.equal(shouldRewrite(null), false)
  assert.equal(shouldRewrite(42), false)
  assert.equal(shouldRewrite('   '), false)
  assert.equal(shouldRewrite('rtk git status'), false)
  assert.equal(shouldRewrite('  rtk git status'), false)
  assert.equal(shouldRewrite('git status', { RTK_DISABLED: '1' }), false)
  assert.equal(shouldRewrite('rtkcat'), true)
})

test('resolveRtkPath walks PATH with PATHEXT on win32', () => {
  const env = { PATH: ['C:\\one', 'C:\\two'].join(delimiter), PATHEXT: '.EXE;.CMD' }
  const found = resolveRtkPath({
    env,
    platform: 'win32',
    isFile: (candidate) => candidate === join('C:\\two', 'rtk.CMD'),
  })
  assert.equal(found, join('C:\\two', 'rtk.CMD'))
  assert.equal(resolveRtkPath({ env, platform: 'win32', isFile: () => false }), null)
  assert.equal(resolveRtkPath({ env: { PATH: '' }, platform: 'linux', isFile: () => true }), null)
})

test('resolveRtkPath looks up the bare name on POSIX', () => {
  const env = { PATH: ['/usr/local/bin', '/usr/bin'].join(delimiter) }
  const found = resolveRtkPath({
    env,
    platform: 'linux',
    isFile: (candidate) => candidate === join('/usr/bin', 'rtk'),
  })
  assert.equal(found, join('/usr/bin', 'rtk'))
})

test('createRewriter treats exit 0 and 3 as rewrites', async () => {
  for (const code of [0, 3]) {
    const calls = []
    const rewrite = createRewriter({
      rtkPath: '/fake/rtk',
      exec: fakeExec({ code, stdout: 'rtk git status\n', calls }),
    })
    assert.equal(await rewrite('git status'), 'rtk git status')
    assert.deepEqual(calls[0].args, ['rewrite', 'git status'])
    assert.equal(calls[0].options.timeout, 2000)
    assert.equal(calls[0].options.windowsHide, true)
  }
})

test('createRewriter passes the original command through on every failure', async () => {
  const cases = [
    { code: 1, stdout: '' },
    { code: 2, stdout: '' },
    { code: 0, stdout: '' },
    { code: 0, stdout: 'git status' },
    { code: -1, stdout: 'rtk git status' },
  ]
  for (const scenario of cases) {
    const rewrite = createRewriter({ rtkPath: '/fake/rtk', exec: fakeExec(scenario) })
    assert.equal(await rewrite('git status'), null, JSON.stringify(scenario))
  }
  const throwing = createRewriter({ rtkPath: '/fake/rtk', exec: fakeExec({ throwOnCall: true }) })
  assert.equal(await throwing('git status'), null)
})

test('createRewriter forwards the abort signal and memoizes only rewrites', async () => {
  const calls = []
  const signal = new AbortController().signal
  const rewrite = createRewriter({
    rtkPath: '/fake/rtk',
    exec: fakeExec({ code: 0, stdout: 'rtk git status', calls }),
  })
  await rewrite('git status', signal)
  await rewrite('git status', signal)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.signal, signal)

  const declining = []
  const declined = createRewriter({ rtkPath: '/fake/rtk', exec: fakeExec({ code: 1, calls: declining }) })
  await declined('git status')
  await declined('git status')
  assert.equal(declining.length, 2)
})

test('apply warns and registers nothing when rtk is absent', () => {
  const { start, registered, warns, fire, makeAgent } = harness({ base: baseBash().definition, rtkPath: '' })
  start()
  fire('agent/created', { agent: makeAgent('a') })
  assert.equal(registered.length, 0)
  assert.match(warns[0], /rtk not found/)
})

test('apply installs one shadow whose schema is byte-identical to the baseline', async () => {
  const base = baseBash()
  const { start, registered, fire, makeAgent } = harness({
    base: base.definition,
    exec: fakeExec({ code: 3, stdout: 'rtk git status' }),
  })
  start()
  fire('agent/created', { agent: makeAgent('a') })
  assert.equal(registered.length, 1)
  const shadow = registered[0]
  assert.equal(shadow.name, base.definition.name)
  assert.equal(shadow.description, base.definition.description)
  assert.deepEqual(shadow.parameters, base.definition.parameters)
  assert.deepEqual(shadow.output, base.definition.output)
  assert.equal(await agentCall(shadow, { command: 'git status', description: 'x' }), 'ran:rtk git status')
  assert.deepEqual(base.calls.at(-1), { command: 'rtk git status', description: 'x' })
})

test('apply runs the original command when the rewrite declines or is disabled', async () => {
  for (const [scenario, env] of [[{ code: 1 }, {}], [{ code: 0, stdout: 'rtk ls' }, { RTK_DISABLED: '1' }]]) {
    const base = baseBash()
    const { start, registered, fire, makeAgent } = harness({ base: base.definition, exec: fakeExec(scenario) })
    const previous = process.env.RTK_DISABLED
    if (env.RTK_DISABLED !== undefined) process.env.RTK_DISABLED = env.RTK_DISABLED
    try {
      start()
      fire('agent/created', { agent: makeAgent('a') })
      assert.equal(await agentCall(registered[0], { command: 'git status', description: 'x' }), 'ran:git status')
      assert.equal(base.calls.at(-1).command, 'git status')
    } finally {
      if (previous === undefined) delete process.env.RTK_DISABLED
      else process.env.RTK_DISABLED = previous
    }
  }
})

test('apply never asks RTK about an already prefixed command', async () => {
  const base = baseBash()
  const calls = []
  const { start, registered, fire, makeAgent } = harness({
    base: base.definition,
    exec: fakeExec({ code: 0, stdout: 'rtk git status', calls }),
  })
  start()
  fire('agent/created', { agent: makeAgent('a') })
  assert.equal(await agentCall(registered[0], { command: 'rtk git status', description: 'x' }), 'ran:rtk git status')
  assert.equal(calls.length, 0)
})

test('apply only wraps the configured tool names', () => {
  const base = baseBash()
  const { start, registered, fire, makeAgent } = harness({
    base: base.definition,
    tools: (toolName) => (toolName === 'bash' ? base.definition : undefined),
  })
  start({ tools: ['pwsh'] })
  fire('agent/created', { agent: makeAgent('a') })
  assert.equal(registered.length, 0)
})

test('apply tolerates an agent with no visible target tool and retries on tools/change', () => {
  const base = baseBash()
  let visible = false
  const { start, registered, fire, makeAgent } = harness({
    base: base.definition,
    tools: () => (visible ? base.definition : undefined),
  })
  start()
  fire('agent/created', { agent: makeAgent('a') })
  assert.equal(registered.length, 0)
  visible = true
  fire('tools/change', {})
  assert.equal(registered.length, 1)
  fire('tools/change', {})
  assert.equal(registered.length, 1)
})

test('apply disposes the scoped registrations when the agent goes away', () => {
  const base = baseBash()
  const { start, fire, makeAgent, disposed } = harness({ base: base.definition })
  start()
  const agent = makeAgent('a')
  fire('agent/created', { agent })
  fire('agent/disposed', { agent })
  assert.deepEqual(disposed, ['a'])
})

test('two consecutive shell-level 127 answers disable rewriting for the process', async () => {
  const calls = []
  const seen = []
  const flaky = {
    name: 'bash',
    description: 'Run commands in a bash shell',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      seen.push(args.command)
      if (args.command.startsWith('rtk ')) return { text: 'bash: line 1: rtk: command not found\n[exit code: 127]' }
      return `ran:${args.command}`
    },
  }
  const { start, registered, fire, makeAgent, warns } = harness({
    base: flaky,
    exec: fakeExec({ code: 0, stdout: 'rtk git status', calls }),
  })
  start()
  fire('agent/created', { agent: makeAgent('a') })
  const shadow = registered[0]

  // First 127: fall back to the original for THIS call; rewriting stays on.
  assert.equal(await agentCall(shadow, { command: 'git status', description: 'x' }), 'ran:git status')
  assert.deepEqual(seen, ['rtk git status', 'git status'])
  assert.equal(warns.length, 0)

  // Second 127: now disabling, still re-running the original.
  assert.equal(await agentCall(shadow, { command: 'git status', description: 'x' }), 'ran:git status')
  assert.match(warns.at(-1), /cannot find `rtk`/)

  // Later calls never ask RTK again (the first two shared one cached rewrite).
  assert.equal(await agentCall(shadow, { command: 'ls -la', description: 'x' }), 'ran:ls -la')
  assert.equal(calls.length, 1)
  assert.deepEqual(seen.at(-1), 'ls -la')
})

test('output that merely mentions the phrase does not disable rewriting', async () => {
  const calls = []
  const quoted = {
    name: 'bash',
    description: 'Run commands in a bash shell',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args) {
      // Documentation/test-fixture text, NOT a shell-level 127.
      if (args.command.startsWith('rtk ')) return 'the docs say `rtk: command not found` when the binary is missing'
      return `ran:${args.command}`
    },
  }
  const { start, registered, fire, makeAgent, warns } = harness({
    base: quoted,
    exec: fakeExec({ code: 0, stdout: 'rtk git status', calls }),
  })
  start()
  fire('agent/created', { agent: makeAgent('a') })
  const shadow = registered[0]

  await agentCall(shadow, { command: 'git status', description: 'x' })
  await agentCall(shadow, { command: 'ls -la', description: 'x' })
  await agentCall(shadow, { command: 'git diff', description: 'x' })
  assert.equal(calls.length, 3, 'every distinct command must still be offered to RTK')
  assert.deepEqual(warns, [])
})

test('the real binary rewrites a supported command (opt-in RTK_BIN)', { skip: !process.env.RTK_BIN }, async () => {
  const rewrite = createRewriter({ rtkPath: process.env.RTK_BIN })
  assert.equal(await rewrite('echo hello'), null)
  const rewritten = await rewrite('git status')
  assert.match(rewritten ?? '', /^rtk git status$/)
})
