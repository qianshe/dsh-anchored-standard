/**
 * rtk-rewrite — transparent RTK rewriting for this preset's `bash` tool.
 *
 * WHAT RTK ACTUALLY DOES (the effect this plugin exists to unlock):
 * `rtk <cmd>` is not a prefix wrapper that just re-runs the command — it runs
 * the command and COMPRESSES ITS OUTPUT before the model reads it, through a
 * per-command filter table that lives in the RTK binary (git status → compact
 * stat, ls → tree + counts, test runners → failures only, ...). Exit codes are
 * forwarded from the underlying command, and when a filter trims a long list
 * (or a command fails) RTK prints a `[full output: rtk recall <hash>]` hint so
 * the model can recover the bytes it did not see. `rtk gain` reports the
 * savings. The rewrite is only the TRIGGER: `rtk rewrite <cmd>` decides
 * whether a filter exists and returns `rtk <cmd>`; everything that makes the
 * harness cheaper happens when the rewritten string actually runs.
 *
 * Therefore the integration must (a) let the REAL shell run the rewritten
 * string — same cwd, env, PATH, sandbox and PTY as the original — and (b) add
 * no output of its own, or the savings are paid back as noise. Both hold here:
 * the shadow tool only rewrites the `command` argument and delegates to the
 * baseline definition's `execute`.
 *
 * WHY A SHADOW TOOL (and not a row that registers `bash` again): the tools
 * registry rejects duplicate names within one layer, and the preset already
 * registers `bash` (persistent shell on POSIX, custom-bash on Windows). A
 * per-agent registration lands in the agent's OWN layer, where shadowing an
 * inherited name is supported. The definition is spread from the baseline, so
 * `name`/`description`/`parameters` stay BYTE-IDENTICAL — the anchored
 * preset's first-request catalog must not move.
 *
 * FAIL-OPEN CONTRACT (mirrors hooks/pi/rtk.ts in the RTK repo):
 *  - `rtk` missing at load            → warn once, register nothing;
 *  - `rtk rewrite` exit 1 or 2        → no equivalent / deny rule → run the original;
 *  - nonzero, timeout, abort, throw   → run the original;
 *  - empty or unchanged stdout        → run the original;
 *  - command already starts `rtk `    → run the original (idempotent);
 *  - `RTK_DISABLED=1` in the env      → run the original.
 * Exit 3 is a REWRITE, not a refusal: with no `~/.claude` permission rules
 * (the default on a machine that never ran `rtk init`) every rewrite answers 3.
 */

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'rtk-rewrite'

/** The tools registry must exist before a shadow can be registered. */
export const inject = ['tools']

/** `rtk rewrite` budget; the binary answers in ~10-40 ms on a warm PATH. */
const DEFAULT_TIMEOUT_MS = 2000

/** Bounded memo of POSITIVE rewrites (a pure function of the command string). */
const MAX_CACHE_ENTRIES = 256

/** `rtk rewrite` exit codes that carry a rewritten command on stdout. */
const REWRITE_EXIT_CODES = new Set([0, 3])

/**
 * Marks a definition THIS plugin registered, so a reconcile can tell its own
 * shadow from a base another row re-registered under the same name. A symbol
 * (not a string key) keeps the marker out of schemas, serialization and any
 * `Object.keys` walk the registry performs on a tool definition.
 */
const SHADOW = Symbol.for('dsh-rtk-rewrite/shadow')

/**
 * What a shell prints when `rtk` ITSELF is missing from the tool's PATH.
 *
 * The plugin resolves the binary from the harness process, but the tool's own
 * shell can still disagree (a login-shell rc, a scrubbed sandbox env). The
 * match is deliberately narrow — a shell prefix, plus the 127 exit marker
 * checked by the caller — because a loose "rtk: not found" substring also
 * appears in documentation, test fixtures and ordinary command output; matching
 * that disabled rewriting for the whole process the first time such text went
 * through bash (observed in practice).
 */
const SHELL_RTK_MISSING = /\bbash: [^\n]*\brtk: command not found\b|\bsh: [^\n]*\brtk: not found\b|'rtk' is not recognized as an internal or external command/i

/** The bash tool's machine-readable non-zero exit marker. */
const EXIT_127 = /\bexit code: 127\b/i

/** Consecutive shell-missing answers before rewriting is switched off. */
const MISSING_STRIKES_TO_DISABLE = 2

/** Best-effort text of a tool's canonical value (string or `{ text }`). */
function outputText(value) {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && typeof value.text === 'string') return value.text
  return ''
}

/** Default file probe: exists and is not a directory. */
function isRunnableFile(candidate) {
  try {
    return existsSync(candidate) && !statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve the `rtk` executable from PATH.
 *
 * PATH only, deliberately: a binary found anywhere else cannot be spawned as a
 * bare `rtk …` by the tool's own shell, so rewriting to it would break the
 * command. On Windows PATHEXT decides the extensions (`rtk.exe` normally).
 *
 * @param {{ env?: Record<string, string | undefined>, platform?: string, isFile?: (p: string) => boolean }} [options]
 * @returns {string | null} absolute path, or null when nothing resolved.
 */
export function resolveRtkPath(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const isFile = options.isFile ?? isRunnableFile
  // Windows exposes `Path` in some shells; Node upper-cases it on win32 only.
  const pathValue = env.PATH ?? env.Path ?? ''
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : ['']
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, `rtk${extension}`)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * Whether this command should be offered to RTK at all.
 *
 * @param {unknown} command - the tool's `command` argument.
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function shouldRewrite(command, env = process.env) {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (trimmed === '') return false
  if (trimmed.startsWith('rtk ')) return false
  if (env.RTK_DISABLED === '1') return false
  return true
}

/**
 * Build the rewrite function: `(command, signal) → rewritten | null`.
 *
 * `exec` is injectable so the test suite can drive every exit code without the
 * real binary. The cache only stores positive answers, so a command that RTK
 * declined is re-asked (RTK may learn a filter from a config edit).
 *
 * @param {{ rtkPath: string, exec?: Function, timeoutMs?: number, cache?: Map<string, string> }} options
 * @returns {(command: string, signal?: AbortSignal) => Promise<string | null>}
 */
export function createRewriter(options) {
  const { rtkPath, exec = execFile, timeoutMs = DEFAULT_TIMEOUT_MS, cache = new Map() } = options
  return function rewrite(command, signal) {
    const cached = cache.get(command)
    if (cached !== undefined) return Promise.resolve(cached)
    return new Promise((resolve) => {
      let settled = false
      const settle = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      try {
        exec(rtkPath, ['rewrite', command], {
          timeout: timeoutMs,
          windowsHide: true,
          encoding: 'utf8',
          ...(signal === undefined ? {} : { signal }),
        }, (error, stdout) => {
          const code = error === null || error === undefined
            ? 0
            : typeof error.code === 'number' ? error.code : -1
          if (!REWRITE_EXIT_CODES.has(code)) return settle(null)
          const rewritten = String(stdout ?? '').trim()
          if (rewritten === '' || rewritten === command) return settle(null)
          if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value)
          cache.set(command, rewritten)
          settle(rewritten)
        })
      } catch {
        // A spawn that throws must never take the tool call down with it.
        settle(null)
      }
    })
  }
}

/**
 * Install the RTK shadow over every `tools` target, per agent.
 *
 * Only agents created under THIS composition arrive here: `agent/created` is
 * scope-filtered by the agent (packages/core/scope/src/scoped-events.generated.ts),
 * and this row is mounted in the preset's standing scope, so a sibling preset
 * never sees the shadow.
 *
 * @param {any} ctx - the preset-scope Cordis context.
 * @param {{ tools?: string[], rtkPath?: string, timeoutMs?: number, exec?: Function }} [config]
 */
export function apply(ctx, config = {}) {
  const toolNames = Array.isArray(config.tools) && config.tools.length > 0 ? config.tools : ['bash']
  const rtkPath = config.rtkPath ?? resolveRtkPath()
  if (rtkPath === null || rtkPath === undefined || rtkPath === '') {
    ctx.logger?.warn?.('rtk-rewrite: rtk not found in PATH — command rewriting disabled')
    return
  }
  const rewrite = createRewriter({
    rtkPath,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(config.exec === undefined ? {} : { exec: config.exec }),
  })

  /** Agents seen under this composition (so a late `bash` row can still be wrapped). */
  const seen = new Set()
  /** agent -> { fiber, wrapped: Map<toolName, baseDefinition>, observed: Set<toolName> }. */
  const installs = new Map()
  /** Re-entrancy guard: our own registration emits `tools/change` synchronously. */
  const installing = new Set()
  /** Set when the tool's shell repeatedly proves it cannot see `rtk` (exit 127). */
  let disabled = false
  /** Consecutive exit-127 answers; any other rewritten answer clears it. */
  let missingStrikes = 0

  /**
   * The definitions that still need a shadow.
   *
   * `ctx.tools.get` is the only authority on what the model would actually run,
   * so this is also what notices a shadow that went AWAY: a scoped layer can be
   * torn down without telling us (a recompose, a re-registered `bash` row, a
   * re-keyed scope), and a lost shadow is completely silent — bash keeps
   * working, RTK just never gets asked again (observed: rewriting died four
   * minutes into a session and stayed dead).
   *
   * `wrapped` covers registries that resolve THROUGH their own layers: when
   * `get` never surfaces a scoped shadow at all, the base we wrapped is still
   * the base, and re-registering every step would be a loop, not a repair.
   */
  const unwrapped = (agent) => {
    const state = installs.get(agent)
    const targets = []
    for (const toolName of toolNames) {
      // Resolve the baseline as THIS agent sees it: the persistent shell on
      // POSIX, custom-bash on Windows, whatever the preset composed.
      const base = ctx.tools.get(toolName, agent)
      if (base === undefined || base === null) continue
      if (base[SHADOW] === true) {
        // Our shadow is the effective definition: nothing to do, and a later
        // disappearance of it is now distinguishable from a registry that
        // simply never surfaced it.
        state?.observed.add(toolName)
        continue
      }
      // Same base we already wrapped, and the registry has never shown our
      // shadow for this tool: a registry that resolves through its own layers.
      if (state !== undefined && state.wrapped.get(toolName) === base && !state.observed.has(toolName)) continue
      targets.push([toolName, base])
    }
    return targets
  }

  const install = (agent) => {
    if (agent === undefined || agent === null) return
    if (installing.has(agent)) return
    installing.add(agent)
    try {
      const targets = unwrapped(agent)
      if (targets.length === 0) return
      const previous = installs.get(agent)
      installs.delete(agent)
      if (previous !== undefined) {
        try {
          previous.fiber?.dispose?.()
        } catch {
          // A fiber that is already gone has nothing to release.
        }
      }
      const fiber = agent.ctx.inject(['tools'], (scoped) => {
        for (const [, base] of targets) {
          scoped.tools.register({
            ...base,
            [SHADOW]: true,
            async execute(args, exec) {
              const command = args !== null && typeof args === 'object' ? args.command : undefined
              if (disabled || !shouldRewrite(command)) return base.execute(args, exec)
              let rewritten
              try {
                rewritten = await rewrite(command, exec?.signal)
              } catch {
                rewritten = null
              }
              if (rewritten === null || rewritten === undefined) return base.execute(args, exec)
              // The shell — not this plugin — runs `rtk <cmd>`, so cwd, env,
              // PATH, sandbox and PTY are exactly the original ones.
              //
              // Deliberately OUTSIDE the guard above: an error thrown here
              // belongs to the tool body (a spawn failure, a cancellation), and
              // re-running the original command would execute it twice.
              const result = await base.execute({ ...args, command: rewritten }, exec)
              const text = outputText(result)
              if (EXIT_127.test(text) && SHELL_RTK_MISSING.test(text)) {
                // Exit 127 means nothing ran: re-running the original is safe.
                // Two consecutive answers disable rewriting for the process, so
                // a misconfigured PATH degrades to plain bash instead of
                // failing every filtered call.
                missingStrikes += 1
                if (missingStrikes >= MISSING_STRIKES_TO_DISABLE && !disabled) {
                  disabled = true
                  const proof = SHELL_RTK_MISSING.exec(text)?.[0] ?? ''
                  ctx.logger?.warn?.(`rtk-rewrite: the tool shell cannot find \`rtk\` (${proof}) — rewriting disabled, commands run unmodified`)
                }
                return base.execute(args, exec)
              }
              missingStrikes = 0
              return result
            },
          })
        }
      })
      installs.set(agent, { fiber, wrapped: new Map(targets), observed: new Set() })
    } finally {
      installing.delete(agent)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    seen.add(agent)
    install(agent)
  })
  // A `bash` row mounted after the first agent (or a recompose) still gets
  // wrapped; installing() keeps our own registration from recursing.
  ctx.on('tools/change', () => {
    for (const agent of seen) install(agent)
  })
  // A registry that drops our scoped layer emits nothing we can hook: the
  // shadow just stops being the definition the agent sees. Re-checking on each
  // status change costs a few map lookups and repairs a lost shadow inside the
  // very step it went missing in.
  ctx.on('agent/status', ({ agent }) => {
    try {
      install(agent)
    } catch {
      // A reconcile must never disturb the step it rides on.
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    seen.delete(agent)
    const state = installs.get(agent)
    installs.delete(agent)
    if (state !== undefined && typeof state.fiber?.dispose === 'function') void state.fiber.dispose()
  })
}
