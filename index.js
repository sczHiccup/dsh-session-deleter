/**
 * Host half of the session-deleter bundle.
 *
 * The Web UI owns the confirmation dialog; this half owns the destructive work
 * and is the only place that touches Session storage. It stops running work
 * through the Workspace archive admission (the same providers the user's own
 * stop actions use), then removes the Session's own durable artifacts:
 * the per-session JSONL log directory and the persisted projection checkpoint.
 * Because a live Agent keeps its persistence handle, it can write either of them
 * back after the removal, so the same guarded removal runs again at increasing
 * delays. The archive mark is different: it is what keeps a still-resident
 * Session out of navigation, so it is released only once no Agent holds the
 * Session any more — and, for ids left by a process that ended first, at the
 * next start.
 *
 * Session deletion has no first-party seam. `dsh-session-persistence-jsonl`
 * states that nothing deletes session files and the seam exposes no deletion
 * API, so this plugin removes the artifacts that backend itself documents:
 *   <root>/--<cwd>--/<sessionId>/session[.vN].jsonl[.zstd]
 *   <storages>/session_projcache/sessions/<sessionId>.json
 * The FTS index is a derived store that reconciles deleted sources by itself,
 * and content-addressed attachments are shared between Sessions, so neither is
 * removed here.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const COMMAND_NAME = 'delete-session'

/** `session.jsonl`, `session.v4.jsonl`, `session.v4.jsonl.zstd`. */
const LOG_FILE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/i
/** Transient files the JSONL backend may leave beside a log. */
const TRANSIENT_FILE = /\.(?:tmp|partial)$/i
const LOCK_FILE = 'session.lock'
/** A readable project directory produced by the JSONL backend. */
const PROJECT_DIRECTORY = /^(?:--.+--|_no-cwd)$/i

const CACHE_DOMAIN = 'session_projcache'
const CACHE_TABLE = 'sessions'

const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EEXIST'])

export const inject = ['commands']

/**
 * Register the `/delete-session` command. The Web UI invokes it through the
 * generated `commands/execute` Remote endpoint, so this is the one operation
 * both the UI action and any other client caller share.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  // A deletion whose Agent outlived the process leaves its archive mark behind;
  // nothing can be live this early after a start, so stale marks can be proven.
  ctx.effect(() => {
    const timers = [3000, 10000, 30000].map((delayMs) => {
      const timer = setTimeout(() => {
        void releaseStaleArchiveMarks(ctx)
      }, delayMs)
      if (typeof timer?.unref === 'function') timer.unref()
      return timer
    })
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, 'session-deleter: stale archive marks')

  ctx.effect(() =>
    ctx.commands.register({
      name: COMMAND_NAME,
      description: 'Permanently delete one Session after the user confirmed the risk.',
      input: { hint: '<sessionId>' },
      handler: (invocation) => runDeletion(ctx, invocation),
    }),
  )
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ rawInput?: string, signal?: AbortSignal }} invocation
 */
async function runDeletion(ctx, invocation) {
  const sessionId = String(invocation.rawInput ?? '').trim()
  if (sessionId.length === 0) {
    return { kind: 'error', text: `Usage: /${COMMAND_NAME} <sessionId>` }
  }

  const persistence = ctx.get('sessionPersistence')
  if (!persistence) {
    return { kind: 'error', text: 'Session persistence is not composed in this profile, so the session cannot be deleted.' }
  }

  const signal = invocation.signal
  const agents = ctx.get('agents')
  const snapshot = await readSnapshot(persistence, sessionId, signal)
  const live = agents?.get(sessionId)
  if (!snapshot && !live) {
    return { kind: 'error', text: `Session ${sessionId} does not exist.` }
  }

  const warnings = []
  const logPath = typeof snapshot?.location?.path === 'string' ? snapshot.location.path : null
  const stopped = await stopRunningWork(ctx, sessionId, warnings)
  const files = await removeSessionFiles(sessionId, logPath, warnings)
  const cached = await removeProjectionRecord(ctx, sessionId, warnings)

  // Report the truth: a Session still readable from storage after the attempt
  // is not deleted, most often because a live Agent still holds its handle.
  const left = await readSnapshot(persistence, sessionId, undefined)
  const remaining = left ? 'The Session is still readable from storage' : null
  let released = false
  if (remaining) {
    warnings.push(`${remaining}; close Harness or prompt another Session and delete it again.`)
  } else {
    // A live Agent keeps its persistence handle after this deletion and can
    // write the log and its projection checkpoint back. Sweep both while it
    // settles, then take the archive mark back once nothing is left to hide.
    scheduleCleanupSweep(ctx, sessionId, logPath)
    released = await releaseArchiveWhenGone(ctx, sessionId)
  }

  const summary = describeOutcome(sessionId, { stopped, files, cached, released })
  if (warnings.length > 0) {
    return { kind: remaining ? 'error' : 'success', text: `${summary}\n${warnings.join('\n')}` }
  }
  return { kind: 'success', text: summary }
}

/**
 * Ask the Workspace registry to stop everything still running for this
 * Session — a turn, owned jobs, running subagents, active reminders — the way
 * the user's own stop actions do, and hide it from navigation in the same
 * durable write. Archiving also gates later wakes of this Session.
 */
async function stopRunningWork(ctx, sessionId, warnings) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry) {
    warnings.push('Running work could not be stopped: the Workspace registry is not composed.')
    return false
  }
  try {
    await registry.archiveSession(sessionId, { stopActivity: true })
    return true
  } catch (error) {
    warnings.push(`Running work could not be stopped: ${describe(error)}`)
    return false
  }
}

/**
 * Remove the Session-owned log directory. Nothing outside that directory is
 * ever touched, and the directory guards below refuse anything that does not
 * look exactly like the documented per-session layout.
 */
async function removeSessionFiles(sessionId, logPath, warnings) {
  if (typeof logPath !== 'string' || logPath.length === 0) {
    return { removed: 0, directory: null, attempted: false }
  }

  const directory = path.dirname(logPath)
  const names = await admittedLogFiles(directory, sessionId, warnings)
  if (names === null) return { removed: 0, directory, attempted: true }

  let removed = 0
  for (const name of names) {
    if (await removeWithRetry(path.join(directory, name), warnings)) removed += 1
  }

  // Never recursive: this only succeeds once the directory is empty, so a file
  // this plugin did not admit above keeps the directory (and its siblings) safe.
  try {
    await fs.rmdir(directory)
  } catch (error) {
    const code = codeOf(error)
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT' && code !== 'EPERM' && code !== 'EBUSY') {
      warnings.push(`The empty session directory ${directory} could not be removed: ${describe(error)}`)
    }
  }
  return { removed, directory, attempted: true }
}

/**
 * Guarded allow-list for one session directory.
 *
 * @returns {Promise<string[] | null>} files safe to remove, or null when the
 *   directory does not prove to be this Session's own log directory.
 */
async function admittedLogFiles(directory, sessionId, warnings) {
  const directoryName = path.basename(directory)
  const projectDirectory = path.basename(path.dirname(directory))

  if (!PROJECT_DIRECTORY.test(projectDirectory)) {
    warnings.push(`Refused to delete ${directory}: it is not inside a session project directory.`)
    return null
  }
  if (!directoryNameMatches(directoryName, sessionId)) {
    warnings.push(`Refused to delete ${directory}: the directory name does not match the session id.`)
    return null
  }

  let entries
  try {
    entries = await fs.readdir(directory)
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') warnings.push(`Could not list ${directory}: ${describe(error)}`)
    return null
  }

  const admitted = []
  for (const entry of entries) {
    if (LOG_FILE.test(entry) || entry === LOCK_FILE || TRANSIENT_FILE.test(entry)) {
      admitted.push(entry)
    } else {
      warnings.push(`Left ${path.join(directory, entry)} in place: it is not a session log file.`)
    }
  }
  if (!admitted.some((entry) => LOG_FILE.test(entry))) {
    warnings.push(`Refused to delete ${directory}: no session log file was found.`)
    return null
  }
  return admitted
}

function directoryNameMatches(directoryName, sessionId) {
  if (sessionId.length === 0) return false
  const escaped = safeEncode(sessionId)
  if (directoryName === sessionId || directoryName === escaped) return true
  return directoryName.includes(sessionId) || (escaped !== null && directoryName.includes(escaped))
}

function safeEncode(value) {
  try {
    return encodeURIComponent(value)
  } catch {
    return null
  }
}

/**
 * Remove the persisted projection checkpoint of this Session. The cache is a
 * derived store addressed by Session id, so a missing record is harmless; the
 * domain handle belongs to the cache plugin and is never closed here.
 */
async function removeProjectionRecord(ctx, sessionId, warnings) {
  const facility = ctx.get('storageDomain')
  if (!facility || typeof facility.get !== 'function') return false
  try {
    const domain = facility.get(CACHE_DOMAIN)
    if (!domain || typeof domain.table !== 'function') return false
    const table = domain.table(CACHE_TABLE)
    if (!table || typeof table.delete !== 'function') return false
    await table.delete(sessionId)
    return true
  } catch (error) {
    warnings.push(`The projection checkpoint could not be removed: ${describe(error)}`)
    return false
  }
}

async function readSnapshot(persistence, sessionId, signal) {
  try {
    return await persistence.stat(sessionId, signal ? { signal } : undefined)
  } catch {
    return undefined
  }
}

/**
 * Re-remove what the settling Agent writes back. A live Agent keeps its
 * persistence handle, so a flush that lands after the deletion can recreate the
 * log file, and a late delivery can make it write a fresh projection checkpoint.
 * Every sweep re-runs the same guarded removal, so anything that reappears in
 * the window is deleted again; nothing else is ever touched.
 */
function scheduleCleanupSweep(ctx, sessionId, logPath) {
  for (const delayMs of [1200, 5000, 20000, 60000, 180000]) {
    const timer = setTimeout(() => {
      void sweepDeletedArtifacts(ctx, sessionId, logPath)
    }, delayMs)
    if (typeof timer?.unref === 'function') timer.unref()
  }
}

async function sweepDeletedArtifacts(ctx, sessionId, logPath) {
  const quiet = []
  await removeSessionFiles(sessionId, logPath, quiet)
  await removeProjectionRecord(ctx, sessionId, quiet)
  await releaseArchiveWhenGone(ctx, sessionId)
}

async function removeWithRetry(target, warnings) {
  let lastError
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rm(target, { force: true })
      return true
    } catch (error) {
      lastError = error
      if (!RETRYABLE_CODES.has(codeOf(error))) break
      // Give a settling Agent or a just-stopped turn the chance to release the
      // handle before reporting a leftover.
      await delay(120 * (attempt + 1))
    }
  }
  warnings.push(`Could not remove ${target}: ${describe(lastError)}`)
  return false
}

/**
 * Take the archive mark back only once it has nothing left to do.
 *
 * The archive set is what keeps a Session out of navigation, and a Session whose
 * Agent is still resident stays in the Host's session list even after its log is
 * gone: releasing the mark then makes a deleted Session reappear in the sidebar.
 * Runtime exposes no way to dispose another owner's Agent, so the mark is kept
 * while `agents` still holds the Session and released as soon as it does not.
 */
async function releaseArchiveWhenGone(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (typeof agents?.get === 'function' && agents.get(sessionId) !== undefined) return false
  return releaseArchiveMark(ctx, sessionId, [])
}

/**
 * Drop archive marks that no longer name anything. A deletion that ran while its
 * Agent stayed resident leaves the mark behind by design; an Agent cannot survive
 * a restart, so the next start proves the Session is gone and takes the mark
 * back. Reads the durable Workspace state through the storage domain the
 * registry itself uses, and only ever removes a mark whose Session is neither
 * stored nor live.
 */
async function releaseStaleArchiveMarks(ctx) {
  const facility = ctx.get('storageDomain')
  const domain = typeof facility?.get === 'function' ? facility.get('workspace') : undefined
  const state = typeof domain?.global?.get === 'function' ? domain.global.get() : undefined
  const archived = Array.isArray(state?.archivedSessionIds) ? state.archivedSessionIds : []
  if (archived.length === 0) return

  const persistence = ctx.get('sessionPersistence')
  const registry = ctx.get('workspaceRegistry')
  const agents = ctx.get('agents')
  if (!persistence || !registry) return

  for (const sessionId of archived) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue
    if (typeof agents?.get === 'function' && agents.get(sessionId) !== undefined) continue
    let present
    try {
      present = (await persistence.stat(sessionId)) !== undefined
    } catch {
      continue
    }
    if (present) continue
    try {
      await registry.unarchiveSession(sessionId)
    } catch {
      // A refusal leaves the mark in place; the next start tries again.
    }
  }
}

/**
 * The supported way to take a mark back. Restoring an id that is not archived
 * resolves without writing, so an absent mark is not an error.
 */
async function releaseArchiveMark(ctx, sessionId, warnings) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry || typeof registry.unarchiveSession !== 'function') return false
  try {
    await registry.unarchiveSession(sessionId)
    return true
  } catch (error) {
    warnings.push(`The archive mark could not be released: ${describe(error)}`)
    return false
  }
}

function describeOutcome(sessionId, { stopped, files, cached, released }) {
  const details = []
  if (stopped) details.push('running work stopped')
  details.push(files.attempted ? `${files.removed} log file(s) removed` : 'no stored log')
  details.push(cached ? 'projection checkpoint removed' : 'no projection checkpoint')
  if (released) details.push('archive mark released')
  return `Deleted session ${sessionId} (${details.join(', ')}).`
}

function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function codeOf(error) {
  if (error && typeof error === 'object' && 'code' in error) return String(error.code)
  return ''
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
