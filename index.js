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
  // Startup reclamation, twice over:
  // - archive marks whose Session no longer exists (a deletion whose Agent
  //   outlived the process left its mark behind by design);
  // - projection checkpoints whose Session no longer exists (a resident Agent
  //   writes its final checkpoint while the process shuts down, long after the
  //   deletion sweep window closed).
  // Nothing can be live this early after a start, and both passes prove each id
  // is neither stored nor live before touching it.
  ctx.effect(() => {
    let orphanSweepDone = false
    let accountSweepDone = false
    const timers = [3000, 10000, 30000].map((delayMs) => {
      const timer = setTimeout(() => {
        void releaseStaleArchiveMarks(ctx)
        if (!orphanSweepDone) {
          void releaseOrphanProjectionRecords(ctx).then((done) => {
            orphanSweepDone = done
          })
        }
        if (!accountSweepDone) {
          void pruneStaleAccounts(ctx).then((done) => {
            accountSweepDone = done
          })
        }
      }, delayMs)
      if (typeof timer?.unref === 'function') timer.unref()
      return timer
    })
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, 'session-deleter: startup reclamation')

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
  // Read the lineage before anything is removed: a subagent Session carries its
  // parent in the stored header, and deleting the parent must not orphan it.
  const descendants = await collectDescendants(persistence, sessionId)
  const stopped = await stopRunningWork(ctx, sessionId, warnings)
  const files = await removeSessionFiles(sessionId, logPath, warnings)
  const cached = await removeProjectionRecord(ctx, sessionId, warnings)
  const cascaded = await removeDescendants(ctx, descendants, warnings)

  // Report the truth: a Session still readable from storage after the attempt
  // is not deleted, most often because a live Agent still holds its handle.
  const left = await readSnapshot(persistence, sessionId, undefined)
  const remaining = left ? 'The Session is still readable from storage' : null
  let released = false
  let pruned = false
  if (remaining) {
    warnings.push(`${remaining}; close Harness or prompt another Session and delete it again.`)
  } else {
    // A live Agent keeps its persistence handle after this deletion and can
    // write the log and its projection checkpoint back. Sweep both while it
    // settles, then take the archive mark back once nothing is left to hide.
    scheduleCleanupSweep(ctx, sessionId, logPath)
    const settled = await releaseWhenGone(ctx, sessionId)
    released = settled.released
    pruned = settled.pruned
  }

  const summary = describeOutcome(sessionId, { stopped, files, cached, released, pruned, cascaded })
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
 * Every stored Session whose header records this one as its parent, at any
 * depth. Subagent Sessions are the only Sessions that carry `parentSession`
 * (a fork deliberately drops it), so this is exactly the subagent subtree.
 */
async function collectDescendants(persistence, sessionId) {
  let snapshots
  try {
    snapshots = await persistence.list()
  } catch {
    return []
  }
  const byParent = new Map()
  for (const snapshot of snapshots ?? []) {
    const parent = snapshot?.header?.parentSession
    if (typeof parent !== 'string' || parent.length === 0) continue
    if (!byParent.has(parent)) byParent.set(parent, [])
    byParent.get(parent).push(snapshot)
  }

  const descendants = []
  const seen = new Set([sessionId])
  const queue = [sessionId]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const child of byParent.get(current) ?? []) {
      const id = child?.header?.id
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
      seen.add(id)
      descendants.push(child)
      queue.push(id)
    }
  }
  return descendants
}

/**
 * Remove the subagent subtree of a deleted Session. These children have no
 * navigation entry and no Workspace account of their own, so once the parent is
 * gone nothing in the UI can reach them — leaving their logs behind would be an
 * invisible leak. They get the same guarded removal and the same cleanup sweep
 * as the parent, because a still-resident child Agent can write its log back.
 */
async function removeDescendants(ctx, descendants, warnings) {
  let removed = 0
  for (const snapshot of descendants) {
    const id = snapshot?.header?.id
    if (typeof id !== 'string' || id.length === 0) continue
    const logPath = typeof snapshot?.location?.path === 'string' ? snapshot.location.path : null
    await removeSessionFiles(id, logPath, warnings)
    await removeProjectionRecord(ctx, id, warnings)
    scheduleCleanupSweep(ctx, id, logPath)
    removed += 1
  }
  return removed
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
  await releaseWhenGone(ctx, sessionId)
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
 * Both leftovers of a deletion — the archive mark and the Workspace account —
 * are only removable once the Session is gone from memory as well as from
 * storage: the registry counts a live Session as a valid member, and the mark is
 * what keeps that live Session out of navigation. Runtime exposes no way to
 * dispose another owner's Agent, so this runs when no Agent holds the Session,
 * is retried by the cleanup sweep, and runs again at the next start for a
 * process that ended first.
 */
async function releaseWhenGone(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (typeof agents?.get === 'function' && agents.get(sessionId) !== undefined) {
    return { released: false, pruned: false }
  }
  const released = await releaseArchiveMark(ctx, sessionId, [])
  const pruned = await pruneSessionAccount(ctx, sessionId)
  return { released, pruned }
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
 * Drop projection checkpoints whose Session no longer exists.
 *
 * A resident Agent writes its final checkpoint while it is disposed, which for a
 * deleted Session can happen at process shutdown — after every cleanup sweep has
 * run. The cache is a derived store with no eviction surface, so the next start
 * is the first moment that write can be observed; it is also the moment nothing
 * can be live, so a missing Session proves the record is garbage. The pass goes
 * through the cache's own domain so memory and medium stay consistent.
 *
 * @returns whether a full pass ran, so a caller does not repeat it.
 */
async function releaseOrphanProjectionRecords(ctx) {
  const facility = ctx.get('storageDomain')
  const domain = typeof facility?.get === 'function' ? facility.get(CACHE_DOMAIN) : undefined
  if (!domain || typeof domain.table !== 'function') return false

  let table
  try {
    table = domain.table(CACHE_TABLE)
  } catch {
    return false
  }
  if (!table || typeof table.keys !== 'function' || typeof table.delete !== 'function') return false

  const persistence = ctx.get('sessionPersistence')
  if (!persistence) return false
  const agents = ctx.get('agents')

  let keys
  try {
    keys = Array.from(table.keys())
  } catch {
    return false
  }

  for (const sessionId of keys) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) continue
    if (typeof agents?.get === 'function' && agents.get(sessionId) !== undefined) continue
    let stored
    try {
      stored = (await persistence.stat(sessionId)) !== undefined
    } catch {
      continue
    }
    if (stored) continue
    try {
      await table.delete(sessionId)
    } catch {
      // A refusal leaves the record; the next start tries again.
    }
  }
  return true
}

/**
 * Drop a deleted Session from the Workspace record that still accounts for it.
 *
 * The registry decides membership when a Workspace record mutates and only
 * filters invalid accounts on read, so a dead id can stay in `sessionIds`
 * indefinitely. Re-running that decision means one mutation of the record, and
 * setting the title it already has is the least visible one; it removes every
 * stale account in that Workspace in a single write.
 */
async function pruneSessionAccount(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  const table = workspaceAccountTable(ctx)
  if (typeof registry?.list !== 'function' || !table) return false
  let entities
  try {
    entities = registry.list()
  } catch {
    return false
  }
  for (const entity of entities) {
    if (!durableAccountIds(table, entity?.id).includes(sessionId)) continue
    if (!(await revalidateWorkspace(entity))) return false
    // The registry keeps a live Session as a valid member even after its log is
    // gone, so a surviving id is a refusal, not a success.
    return !durableAccountIds(table, entity?.id).includes(sessionId)
  }
  return false
}

/**
 * Re-check every Workspace account against storage at start. Runs only when a
 * Workspace actually accounts for something that is neither stored nor live, so
 * an ordinary start writes nothing.
 *
 * Detection reads the durable record, not `entity.sessionIds`: that getter
 * already filters invalid accounts out, so a stale id is invisible there while
 * it still sits in the stored record — and only a record mutation drops it.
 *
 * @returns whether a full pass ran, so a caller does not repeat it.
 */
async function pruneStaleAccounts(ctx) {
  const registry = ctx.get('workspaceRegistry')
  const persistence = ctx.get('sessionPersistence')
  const agents = ctx.get('agents')
  const table = workspaceAccountTable(ctx)
  if (typeof registry?.list !== 'function' || !persistence || !table) return false

  let entities
  try {
    entities = registry.list()
  } catch {
    return false
  }

  for (const entity of entities) {
    const ids = durableAccountIds(table, entity?.id)
    let stale = false
    for (const id of ids) {
      if (typeof id !== 'string' || id.length === 0) continue
      if (typeof agents?.get === 'function' && agents.get(id) !== undefined) continue
      try {
        if ((await persistence.stat(id)) !== undefined) continue
      } catch {
        continue
      }
      stale = true
      break
    }
    if (!stale) continue
    await revalidateWorkspace(entity)
  }
  return true
}

/** The durable Workspace records, through the storage domain the registry uses. */
function workspaceAccountTable(ctx) {
  const facility = ctx.get('storageDomain')
  if (typeof facility?.get !== 'function') return undefined
  let domain
  try {
    domain = facility.get('workspace')
  } catch {
    return undefined
  }
  if (!domain || typeof domain.table !== 'function') return undefined
  try {
    return domain.table('workspaces')
  } catch {
    return undefined
  }
}

function durableAccountIds(table, workspaceId) {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return []
  try {
    const record = table?.get?.(workspaceId)
    const ids = record?.sessionIds
    return Array.isArray(ids) ? ids : []
  } catch {
    return []
  }
}

async function revalidateWorkspace(entity, warnings) {
  try {
    if (typeof entity?.setTitle !== 'function') return false
    await entity.setTitle(entity.title)
  } catch (error) {
    warnings?.push(`The Workspace account could not be pruned: ${describe(error)}`)
    return false
  }
  return true
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

function describeOutcome(sessionId, { stopped, files, cached, released, pruned, cascaded }) {
  const details = []
  if (stopped) details.push('running work stopped')
  details.push(files.attempted ? `${files.removed} log file(s) removed` : 'no stored log')
  details.push(cached ? 'projection checkpoint removed' : 'no projection checkpoint')
  if (cascaded > 0) details.push(`${cascaded} subagent session(s) removed`)
  if (released) details.push('archive mark released')
  if (pruned) details.push('workspace account pruned')
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
