/**
 * rg-shim — make the ripgrep dsh ALREADY ships usable from the model's bash.
 *
 * WHY: dsh bundles ripgrep (`@vscode/ripgrep-<platform>/bin/rg`) inside the
 * app and uses it internally for the native `grep`/`glob` tools, but it spawns
 * that binary directly (`spawn(rgPath, argv)`) and never puts it on PATH. Codex
 * does the opposite: it ships `vendor/.../codex-path/rg.exe` and prepends that
 * directory to the PATH of the commands it runs, which is why `rg` works there
 * and not here. The model's `bash` in dsh inherits the HARNESS process PATH, so
 * a system-wide ripgrep is the only thing it can see.
 *
 * WHAT THIS DOES: when `rg` is not already on PATH, link (or copy) the ripgrep
 * that is already on disk into a directory that IS on PATH. Nothing is
 * downloaded or installed; the shim only points at a binary that shipped with
 * dsh. Idempotent: an up-to-date shim is left alone, and the whole thing is a
 * no-op once a real `rg` is on PATH.
 *
 * WHY NOT MUTATE `process.env.PATH`: measured on Windows — a Windows-style
 * PATH entry containing backslashes and spaces is mangled by MSYS when Git
 * Bash starts (`F:\devUtil\deepseek harness\...` arrived as
 * `F:devUtildeepseek harness...`), which corrupts the PATH for every bash
 * tool call. A shim in an existing PATH directory avoids touching PATH at all.
 *
 * WHY NOT A SHELL WRAPPER: `rtk rg` (and any Windows-native spawn) resolves
 * `rg` through PATHEXT, so the shim must be `rg.exe` / `rg`, not a script that
 * a POSIX shell alone understands.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'


/** Cordis plugin name used by loader diagnostics. */
export const name = 'rg-shim'

/** What the shim is called on this platform. */
const BIN_NAME = process.platform === 'win32' ? 'rg.exe' : 'rg'

/** Default install directory: on PATH for the user's shells on both platforms. */
const DEFAULT_BIN_DIR = join(homedir(), '.local', 'bin')

function isRunnableFile(candidate) {
  try {
    return existsSync(candidate) && !statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/** The PATH separator of a TARGET platform (not of the running one). */
function pathSeparator(platform) {
  return platform === 'win32' ? ';' : ':'
}

/** Compare a directory against the PATH list, tolerating case and separators. */
export function isOnPath(dir, env = process.env, platform = process.platform) {
  const value = env.PATH ?? env.Path ?? ''
  const normalize = (entry) => platform === 'win32' ? entry.replace(/[\\/]+$/, '').toLowerCase() : entry.replace(/\/+$/, '')
  const wanted = normalize(dir)
  return value.split(pathSeparator(platform)).filter(Boolean).some((entry) => normalize(entry) === wanted)
}

/** First `rg` already reachable through PATH, or null. */
export function findRgOnPath(env = process.env, platform = process.platform, isFile = isRunnableFile) {
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : ['']
  for (const dir of (env.PATH ?? env.Path ?? '').split(pathSeparator(platform)).filter(Boolean)) {
    if (platform !== 'win32') {
      const candidate = join(dir, 'rg')
      if (isFile(candidate)) return candidate
      continue
    }
    for (const ext of exts) {
      const candidate = join(dir, `rg${ext}`)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * ripgrep binaries that already exist on this machine, most specific first.
 *
 * `resourcesPath` is Electron's `<app>/resources`; the CLI build has none and
 * falls back to whatever the caller passes in `config.rgPath`.
 *
 * @param {{ resourcesPath?: string, rgPath?: string, platform?: string }} [options]
 * @returns {string[]}
 */
export function bundledCandidates(options = {}) {
  const platform = options.platform ?? process.platform
  const bin = platform === 'win32' ? 'rg.exe' : 'rg'
  const list = []
  if (typeof options.rgPath === 'string' && options.rgPath !== '') list.push(options.rgPath)
  const resources = options.resourcesPath
  if (typeof resources === 'string' && resources !== '') {
    const modules = join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', '@vscode')
    const fixed = join(modules, `ripgrep-${platform}-${process.arch}`, 'bin', bin)
    if (existsSync(fixed)) list.push(fixed)
    // Versioned/arch-suffixed package directories, e.g. ripgrep-win32-x64.
    try {
      for (const entry of readdirSync(modules)) {
        if (!entry.startsWith('ripgrep')) continue
        const candidate = join(modules, entry, 'bin', bin)
        if (existsSync(candidate)) list.push(candidate)
      }
    } catch {
      // The unpacked tree is absent (CLI build, or a future packaging change).
    }
  }
  return [...new Set(list)]
}

/**
 * Link (preferred) or copy a bundled ripgrep into `binDir`.
 *
 * Everything is injectable so the unit suite can drive every branch without
 * touching the real filesystem.
 *
 * @param {{
 *   source: string,
 *   binDir?: string,
 *   isFile?: (path: string) => boolean,
 *   sizeOf?: (path: string) => number,
 *   link?: (target: string, path: string) => void,
 *   copy?: (source: string, target: string) => void,
 *   remove?: (path: string) => void,
 *   makeDir?: (dir: string) => void,
 * }} options
 * @returns {{ status: 'linked'|'copied'|'current', target: string }}
 */
export function writeShim(options) {
  const binDir = options.binDir ?? DEFAULT_BIN_DIR
  const isFile = options.isFile ?? isRunnableFile
  const sizeOf = options.sizeOf ?? ((path) => statSync(path).size)
  const link = options.link ?? ((target, path) => symlinkSync(target, path, 'file'))
  const copy = options.copy ?? ((source, target) => copyFileSync(source, target))
  const remove = options.remove ?? ((path) => unlinkSync(path))
  const makeDir = options.makeDir ?? ((dir) => mkdirSync(dir, { recursive: true }))

  makeDir(binDir)
  const target = join(binDir, BIN_NAME)
  if (isFile(target) && sizeOf(target) === sizeOf(options.source)) return { status: 'current', target }

  // Replace a stale shim; a broken link reads as "not a file" but still blocks
  // creation, so clear the path first.
  try {
    if (existsSync(target)) remove(target)
  } catch {
    // Leave it: the copy below will fail loudly enough to be reported.
  }
  try {
    link(options.source, target)
    return { status: 'linked', target }
  } catch {
    copy(options.source, target)
    return { status: 'copied', target }
  }
}

/**
 * Ensure the model's bash can run `rg`, reusing a binary that already exists.
 *
 * @param {any} ctx - the preset-scope Cordis context.
 * @param {{ rgPath?: string, binDir?: string }} [config]
 * @returns {'present'|'linked'|'copied'|'missing-source'|'off-path'|'failed'}
 */
export function apply(ctx, config = {}) {
  try {
    if (findRgOnPath() !== null) return 'present'
    const source = bundledCandidates({
      ...(config.rgPath === undefined ? {} : { rgPath: config.rgPath }),
      ...(process.resourcesPath === undefined ? {} : { resourcesPath: process.resourcesPath }),
    }).find((candidate) => isRunnableFile(candidate))
    if (source === undefined) {
      ctx.logger?.warn?.('rg-shim: rg is not on PATH and no bundled ripgrep was found — bash keeps using grep')
      return 'missing-source'
    }
    const binDir = config.binDir ?? DEFAULT_BIN_DIR
    if (!isOnPath(binDir)) {
      ctx.logger?.warn?.(`rg-shim: ${binDir} is not on PATH — add it, or set binDir to a directory that is`)
      return 'off-path'
    }
    const { status, target } = writeShim({ source, binDir })
    ctx.logger?.info?.(`rg-shim: ${status === 'current' ? 'rg already shimmed' : `rg ${status} from ${source}`} → ${target}`)
    return status
  } catch (error) {
    ctx.logger?.warn?.(`rg-shim: failed to expose the bundled ripgrep (${String(error)}) — bash keeps using grep`)
    return 'failed'
  }
}
