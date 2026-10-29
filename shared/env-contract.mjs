/**
 * env-contract — one post-promotion statement of how this workspace behaves.
 *
 * WHY: the anchored preset deliberately keeps request #1 free of injected
 * context (the context gate strips it) and keeps the persona tiny. That means
 * every NEW session starts without knowing facts that decide whether the model
 * wastes tokens:
 *
 *   1. Windows bash defaults to the workspace root on each fresh call. POSIX
 *      bash starts there initially, but later calls retain directory changes.
 *      These facts belong after promotion; the anchored tool description stays fixed.
 *   2. `rg` is available: rg-shim put the ripgrep dsh already ships on PATH.
 *   3. Routine execution uses thinking/tools; questions and results stay visible.
 *
 * NOTHING ABOUT RTK. Rewriting is transparent by design — the model sees the
 * same output it would have seen from an unwrapped command, and the one case
 * that is not self-explanatory (a filter elided lines) already prints its own
 * `rtk recall <hash>` hint in the result. A standing sentence about the
 * harness would be paid for in every session to teach something the results
 * teach on demand, so it is deliberately absent.
 *
 * ONLY THE UNKNOWN, NOTHING DERIVABLE. The model already knows what ripgrep
 * does with .gitignore and that grep fits pipes; restating that spends context
 * to say nothing. What it cannot know from inside the prompt is whether THIS
 * shell has `rg`, where bash starts, and the preset's reporting convention.
 *
 * Injecting this into the SYSTEM PROMPT would defeat the anchor (every request
 * would carry it, including request #1). Injecting it as one durable
 * post-promotion `user/message` keeps request #1 byte-identical and still puts
 * the facts in front of the model from request #2 on, in every new session.
 *
 * WORDING: factual, never imperative. The instruction-hint measurement (issue
 * #49) showed directive text ("read … first and follow them") flips the
 * anchored "we / let's" trajectory back to "let me"; statements of environment
 * do not ask the model to change persona.
 *
 * The `rg` sentence is emitted only when `rg` is actually on PATH, so a
 * composition without rg-shim never claims a tool that is not there.
 */

import { randomUUID } from 'node:crypto'

import { createEpochPromotion, sessionEvents } from './compaction-epoch.mjs'
import { findRgOnPath } from './rg-shim.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'env-contract'

/** Durable session event types that count as a promotion signal. */
const PROMOTE_EVENTS = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/** Every config key this plugin accepts — anything else is a typo. */
const ALLOWED_KEYS = new Set(['promoteOn', 'includeSubagents', 'text'])

/** Header every contract opens with. */
const HEADER = 'Environment facts for this session:'

/** Shell defaults, stated after promotion on every platform. */
const CWD_LINE_FRESH = '- bash defaults to the session workspace root on each call unless workdir is supplied; relative paths need no leading `cd`.'
const CWD_LINE_PERSISTENT = '- bash initially starts in the session workspace root; later calls retain directory changes made by `cd`.'

/** Experimental reporting convention; effectiveness still needs neutral-task A/B evidence. */
const EXECUTION_LINE = '- Unless progress reports are requested, routine execution uses thinking and tool calls; assistant replies carry necessary questions, blockers, and the final result.'

/** Added only when a real `rg` is on PATH. */
const RG_LINE = '- `rg` (ripgrep) is on PATH and reads .gitignore.'

function parsePromoteOn(value) {
  if (value === undefined || value === 'either') return PROMOTE_EVENTS.either
  if (value === 'tool-call' || value === 'assistant-message') return PROMOTE_EVENTS[value]
  throw new TypeError(`${name}: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`)
}

/**
 * Build the contract text for the current environment.
 *
 * @param {string | undefined} override - `config.text`, used verbatim when set.
 * @param {string} [platform] - selects fresh Windows or persistent POSIX shell facts.
 */
export function contractText(override, platform = process.platform) {
  if (typeof override === 'string') {
    if (override.trim() === '') throw new TypeError(`${name}: text must be a non-empty string`)
    return override
  }
  const lines = [HEADER]
  if (findRgOnPath() !== null) lines.push(RG_LINE)
  lines.push(platform === 'win32' ? CWD_LINE_FRESH : CWD_LINE_PERSISTENT, EXECUTION_LINE)
  return lines.join('\n')
}

/**
 * Register the once-per-session environment contract.
 *
 * @param {any} ctx - the preset-scope Cordis context.
 * @param {{ promoteOn?: string, includeSubagents?: boolean, text?: string }} [config]
 */
export function apply(ctx, config = {}) {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const unknown = Object.keys(config).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) {
    throw new TypeError(`${name}: unknown config key(s) ${unknown.join(', ')} — allowed keys: ${[...ALLOWED_KEYS].sort().join(', ')}`)
  }
  if (config.includeSubagents !== undefined && typeof config.includeSubagents !== 'boolean') {
    throw new TypeError(`${name}: includeSubagents must be a boolean`)
  }
  if (config.text !== undefined && (typeof config.text !== 'string' || config.text.trim() === '')) {
    throw new TypeError(`${name}: text must be a non-empty string`)
  }
  const events = parsePromoteOn(config.promoteOn)
  const promotion = createEpochPromotion(events, { includeSubagents: config.includeSubagents === true })
  ctx.on('session/event', (session, event) => promotion.observe(session, event))

  /** Sessions whose contract is already durable in the log (restart-safe). */
  const injected = new Map()
  const isDurable = (session) => {
    const known = injected.get(session.id)
    if (known !== undefined) return known
    const found = sessionEvents(session).some((event) =>
      event.type === 'user/message' && event.data?.source?.kind === name,
    )
    injected.set(session.id, found)
    return found
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message' && event.data?.source?.kind === name) injected.set(session.id, true)
  })

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    try {
      if (promotion.status(agent).promoted !== true) return decision
      const session = agent.session
      if (session === undefined || isDurable(session)) return decision
      injected.set(session.id, true)
      return {
        ...decision,
        messages: [...decision.messages, {
          id: `env-contract-${session.id}-${randomUUID()}`,
          role: 'user',
          content: [{ type: 'text', text: contractText(config.text) }],
          source: { kind: name, form: 'hint' },
        }],
      }
    } catch (error) {
      // A contract bug must never hurt the session.
      ctx.logger?.warn?.(`${name}: injection failed, skipping: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
