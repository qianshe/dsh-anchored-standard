/**
 * rg-shim — unit coverage for reusing the ripgrep dsh already ships.
 *
 * The pure helpers are driven directly; the `apply` cases run against real
 * temp directories with PATH swapped in and restored, so they prove the shim
 * lands in a directory the shell will actually search.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { apply, bundledCandidates, findRgOnPath, isOnPath, name, writeShim } from '../shared/rg-shim.mjs'

const BIN = process.platform === 'win32' ? 'rg.exe' : 'rg'
const ROOT = mkdtempSync(join(tmpdir(), 'rg-shim-'))

function cleanup() {
  rmSync(ROOT, { recursive: true, force: true })
}
test.after(cleanup)

/** Create a fake binary file at `<root>/<rel>` and return its path. */
function fakeFile(rel, contents = 'fake-ripgrep') {
  const path = join(ROOT, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  return path
}

/** Run `apply` with a temporary PATH and restore it afterwards. */
function withPath(value, run) {
  const previous = process.env.PATH
  process.env.PATH = value
  try {
    return run()
  } finally {
    process.env.PATH = previous
  }
}

test('plugin identity matches the composition row', () => {
  assert.equal(name, 'rg-shim')
})

test('isOnPath matches entries exactly, ignoring case and trailing separators on win32', () => {
  assert.equal(isOnPath('/usr/bin', { PATH: '/usr/local/bin:/usr/bin:/bin' }, 'linux'), true)
  assert.equal(isOnPath('/usr/bin/', { PATH: '/usr/local/bin:/usr/bin' }, 'linux'), true)
  assert.equal(isOnPath('/usr/bin', { PATH: '/usr/bin-extra:/bin' }, 'linux'), false)
  assert.equal(isOnPath('C:\\Tools', { PATH: 'C:\\Windows;C:\\Tools;' }, 'win32'), true)
  assert.equal(isOnPath('c:\\tools\\', { PATH: 'C:\\Windows;C:\\Tools' }, 'win32'), true)
  assert.equal(isOnPath('C:\\Tools', { PATH: 'C:\\Tools-extra' }, 'win32'), false)
})

test('findRgOnPath walks PATH and honours PATHEXT on win32', () => {
  const found = findRgOnPath(
    { PATH: ['C:\\a', 'C:\\b'].join(';'), PATHEXT: '.EXE;.CMD' },
    'win32',
    (candidate) => candidate === join('C:\\b', 'rg.EXE'),
  )
  assert.equal(found, join('C:\\b', 'rg.EXE'))
  assert.equal(findRgOnPath({ PATH: '' }, 'linux', () => true), null)
})

test('bundledCandidates puts an explicit rgPath first and ignores a missing resources tree', () => {
  assert.deepEqual(bundledCandidates({ rgPath: '/opt/rg' }), ['/opt/rg'])
  assert.deepEqual(bundledCandidates({ resourcesPath: join(ROOT, 'nope') }), [])
})

test('bundledCandidates discovers the packaged @vscode/ripgrep layout', () => {
  const bin = fakeFile(`resources/app.asar.unpacked/dsh/node_modules/@vscode/ripgrep-win32-x64/bin/${BIN}`)
  const candidates = bundledCandidates({ resourcesPath: join(ROOT, 'resources') })
  assert.ok(candidates.includes(bin), JSON.stringify(candidates))
})

test('writeShim prefers a link and falls back to a copy', () => {
  const source = fakeFile('src/rg-source')
  const dir = join(ROOT, 'bin-link')
  const linked = writeShim({ source, binDir: dir, isFile: () => false })
  assert.equal(linked.status === 'linked' || linked.status === 'copied', true)
  assert.equal(existsSync(join(dir, BIN)), true)

  const copyDir = join(ROOT, 'bin-copy')
  let copied = false
  const result = writeShim({
    source,
    binDir: copyDir,
    isFile: () => false,
    link: () => { throw new Error('symlink not permitted') },
    copy: (from, to) => { copied = true; mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, readFileSync(from)) },
  })
  assert.equal(result.status, 'copied')
  assert.equal(copied, true)
})

test('writeShim leaves an up-to-date shim alone and replaces a stale one', () => {
  const source = fakeFile('src/rg-source-2', 'current-binary')
  const dir = join(ROOT, 'bin-current')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, BIN)
  writeFileSync(target, 'current-binary')
  const current = writeShim({ source, binDir: dir, link: () => { throw new Error('should not link') } })
  assert.equal(current.status, 'current')

  writeFileSync(target, 'stale')
  const replaced = writeShim({ source, binDir: dir })
  assert.ok(['linked', 'copied'].includes(replaced.status))
  assert.equal(readFileSync(target, 'utf8'), 'current-binary')
})

test('apply is a no-op when rg is already on PATH', () => {
  const dir = join(ROOT, 'path-rg')
  fakeFile('path-rg/' + BIN)
  const warns = []
  const ctx = { on: () => () => {}, logger: { warn: (m) => warns.push(m), info: () => {} } }
  const status = withPath(dir, () => apply(ctx, { binDir: join(ROOT, 'unused') }))
  assert.equal(status, 'present')
  assert.deepEqual(warns, [])
})

test('apply reports a missing source instead of writing anything', () => {
  const warns = []
  const ctx = { on: () => () => {}, logger: { warn: (m) => warns.push(m), info: () => {} } }
  const status = withPath('', () => apply(ctx, { rgPath: join(ROOT, 'no-such-rg'), binDir: join(ROOT, 'bin-missing') }))
  assert.equal(status, 'missing-source')
  assert.match(warns[0], /no bundled ripgrep/)
  assert.equal(existsSync(join(ROOT, 'bin-missing')), false)
})

test('apply refuses to write a shim into a directory PATH does not search', () => {
  const source = fakeFile('src/rg-source-3')
  const warns = []
  const ctx = { on: () => () => {}, logger: { warn: (m) => warns.push(m), info: () => {} } }
  const binDir = join(ROOT, 'bin-off-path')
  const status = withPath(join(ROOT, 'somewhere-else'), () => apply(ctx, { rgPath: source, binDir }))
  assert.equal(status, 'off-path')
  assert.match(warns[0], /not on PATH/)
  assert.equal(existsSync(binDir), false)
})


test('apply links the bundled binary into a PATH directory, then reports present', () => {
  const source = fakeFile('src/rg-source-4', 'shim-me')
  const binDir = join(ROOT, 'bin-ok')
  mkdirSync(binDir, { recursive: true })
  const ctx = { on: () => () => {}, logger: { warn: () => {}, info: () => {} } }
  const status = withPath(binDir, () => apply(ctx, { rgPath: source, binDir }))
  assert.ok(['linked', 'copied'].includes(status), status)
  assert.equal(existsSync(join(binDir, BIN)), true)
  const again = withPath(binDir, () => apply(ctx, { rgPath: source, binDir }))
  assert.equal(again, 'present')
})
