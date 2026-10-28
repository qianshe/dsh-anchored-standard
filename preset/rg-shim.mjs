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

import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createEpochPromotion, sessionEvents } from './compaction-epoch.mjs'

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
 * The one post-promotion line that makes `rg` discoverable.
 *
 * ONLY THE UNKNOWN. The model already knows what ripgrep is, that it honours
 * .gitignore, that it pipes, and that grep is fine downstream — restating any
 * of that spends context to tell it something it came with. What it cannot
 * know from here is whether THIS shell has `rg` at all: in dsh the bundled
 * ripgrep lives inside the app and every previous session ran on grep. So the
 * hint carries exactly that one fact and lets prior knowledge do the rest.
 *
 * WORDING: factual, never imperative. The anchored preset measured that
 * directive hint text ("read ... first and follow them") flips the "we /
 * let's" trajectory back to "let me" (instruction-hint, issue #49).
 *
 * ESCALATION LADDER — only climb when a session's measured adoption stays low
 * (count bash calls matching `rg` vs `grep`):
 *   1. `rg` is available.                                      <- here
 *   2. + "repository-wide search is much faster with it than with `grep`"
 *   3. + an imperative ("use rg for ...") — never: it costs the anchor.
 */
const HINT_TEXT = 'Environment: `rg` (ripgrep) is available in this bash.'

/** Durable session event types that count as a promotion signal. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Register the once-per-session hint that makes `rg` discoverable. */
function registerHint(ctx, config) {
  const promoteOn = config.promoteOn ?? 'either'
  const events = PROMOTE_EVENTS[promoteOn]
  if (events === undefined) {
    ctx.logger?.warn?.(`${name}: promoteOn must be "tool-call", "assistant-message" or "either"; hint disabled`)
    return
  }
  const promotion = createEpochPromotion(events, { includeSubagents: config.includeSubagents === true })
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  /** Sessions whose hint is already durable in the log (restart-safe). */
  const hinted = new Map()
  /** One warning per process if the hint path throws. */
  let warned = false
  const isDurable = (session) => {
    const known = hinted.get(session.id)
    if (known !== undefined) return known
    const found = sessionEvents(session).some((event) =>
      event.type === 'user/message' && event.data?.source?.kind === name,
    )
    hinted.set(session.id, found)
    return found
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message' && event.data?.source?.kind === name) hinted.set(session.id, true)
  })

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    try {
      if (findRgOnPath() === null) return decision
      if (promotion.status(agent).promoted !== true) return decision
      const session = agent.session
      if (session === undefined || isDurable(session)) return decision
      hinted.set(session.id, true)
      return {
        ...decision,
        messages: [...decision.messages, {
          id: `rg-hint-${session.id}-${randomUUID()}`,
          role: 'user',
          content: [{ type: 'text', text: HINT_TEXT }],
          source: { kind: name, form: 'hint' },
        }],
      }
    } catch (error) {
      // A hint bug must never hurt the session — but it must not hide either:
      // a swallowed hint is indistinguishable from a model that ignores it.
      if (!warned) {
        warned = true
        ctx.logger?.warn?.(`${name}: hint skipped (${String(error)}) — rg still works, the model was just never told`)
      }
      return decision
    }
  }, { prepend: true })
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
    if (findRgOnPath() !== null) {
      if (config.hint !== false) registerHint(ctx, config)
      return 'present'
    }
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
    if (config.hint !== false && findRgOnPath() !== null) registerHint(ctx, config)
    return status
  } catch (error) {
    ctx.logger?.warn?.(`rg-shim: failed to expose the bundled ripgrep (${String(error)}) — bash keeps using grep`)
    return 'failed'
  }
}
