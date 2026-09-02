/**
 * The file store: the small-party and demo profile.
 *
 * A mounted volume holding JSON. **Zero database containers** — which is the
 * whole reason a one-truck haulier can afford to run this at all.
 *
 * **Stated limitation: single-writer, single-process.** No horizontal scaling,
 * no replicas. That is correct for the profile and a footgun if left unwritten,
 * so it is written here and in docs/ARCHITECTURE.md §7.2. Scaling out means
 * moving to the document-store profile, not making this adapter clever.
 *
 * The layout is deliberately readable, because S4b's tamper demo is "edit an
 * event in the store by hand" — with one JSONL file per instance, that is a
 * text editor and nothing else.
 *
 *     <dir>/collections/<name>/<participantId>/<id>.json
 *     <dir>/events/<participantId>/<instanceId>.jsonl
 *     <dir>/audit/<participantId>.jsonl
 *
 * One file per document, not one array per collection. Rewriting a whole
 * collection on every write is quadratic, and it showed: with the array layout,
 * a write cost ~48 ms once a few hundred instances existed.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { AuditEntry, StoredEvent } from '@pilots/protocol'

import type { InstanceDocument, Store } from '../store.js'
import type { IdempotencyRecord, StoredDocument } from '../types.js'
import {
  MemoryStore,
  documentKey,
  emptyState,
  reconcileInstance,
  type Journal,
  type MemoryState,
} from '../memory/memory-store.js'

const COLLECTIONS = [
  'participants',
  'apiKeys',
  'connections',
  'offerings',
  'subscriptions',
  'instances',
  'notifications',
  'trustedPeers',
  'idempotency',
] as const

/**
 * Collections whose documents are caches of the event log, and so need no
 * `fsync`: reopening reconciles them from the log, which is the truth.
 */
const REBUILDABLE = new Set(['instances'])

/** File names must not be attacker-chosen path fragments. */
function safeName(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..'
    ? value
    : `h_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
}

/**
 * Write via a temporary file and rename.
 *
 * `rename` is atomic within a filesystem, so a reader — or a crash — never sees
 * a half-written document.
 *
 * `durable` decides whether to pay for `fsync`, and the answer follows from what
 * the file *is*. The event log and the audit log are **the record**: they are
 * fsynced. A materialised instance is a **cache of the log**, and losing one
 * costs a reconcile on the next boot, which `reconcile()` already does — so it
 * is not. That single distinction is most of this adapter's write throughput.
 */
async function writeAtomic(
  path: string,
  contents: string | Uint8Array,
  durable = true,
): Promise<void> {
  const temporary = `${path}.tmp`
  const handle = await open(temporary, 'w')
  try {
    if (typeof contents === 'string') await handle.writeFile(contents, 'utf8')
    else await handle.writeFile(contents)
    if (durable) await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)

  if (!durable) return
  const directory = await open(dirname(path), 'r')
  try {
    await directory.sync()
  } catch {
    // Directory fsync is not supported everywhere; the rename still happened.
  } finally {
    await directory.close()
  }
}

async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'a')
  try {
    await handle.writeFile(`${line}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readLines<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return []
  const contents = await readFile(path, 'utf8')
  return contents
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as T)
}

/** Serialises disk writes onto one chain. The critical sections are already atomic. */
interface WriteQueue {
  current: Promise<unknown>
}

function documentPath(
  directory: string,
  collection: string,
  participantId: string,
  id: string,
): string {
  return join(
    directory,
    'collections',
    safeName(collection),
    safeName(participantId),
    `${safeName(id)}.json`,
  )
}

function makeFileJournal(directory: string, queue: WriteQueue): Journal {
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(work, work)
    queue.current = next.catch(() => undefined)
    return next
  }

  return {
    writeDocument: (collection, document) =>
      enqueue(async () => {
        const path = documentPath(directory, collection, document.participantId, document.id)
        await mkdir(dirname(path), { recursive: true })
        await writeAtomic(
          path,
          `${JSON.stringify(document, null, 2)}\n`,
          !REBUILDABLE.has(collection),
        )
      }),
    deleteDocument: (collection, participantId, id) =>
      enqueue(() => rm(documentPath(directory, collection, participantId, id), { force: true })),
    appendEvent: (event) =>
      enqueue(() =>
        appendLine(
          join(
            directory,
            'events',
            safeName(event.participantId),
            `${safeName(event.header.instance)}.jsonl`,
          ),
          JSON.stringify(event),
        ),
      ),
    rewriteEvents: (participantId, instanceId, events) =>
      enqueue(async () => {
        const path = join(
          directory,
          'events',
          safeName(participantId),
          `${safeName(instanceId)}.jsonl`,
        )
        await mkdir(dirname(path), { recursive: true })
        // Durable: this is the log, and the log is the record.
        await writeAtomic(
          path,
          `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
          true,
        )
      }),
    writeAttachment: (participantId, attachment) =>
      enqueue(async () => {
        // Real files, not base64 in a document. The bytes are the point, and a
        // PDF that has to be decoded before it can be served is a PDF nobody can
        // inspect with `open`.
        const dir = join(directory, 'attachments', safeName(participantId))
        await mkdir(dir, { recursive: true })
        const name = safeName(attachment.sha256)
        await writeAtomic(join(dir, `${name}.bin`), Buffer.from(attachment.bytes), true)
        await writeAtomic(
          join(dir, `${name}.json`),
          `${JSON.stringify({
            sha256: attachment.sha256,
            mime: attachment.mime,
            size: attachment.size,
            receivedAt: attachment.receivedAt,
          })}\n`,
          true,
        )
      }),
    appendAudit: (entry) =>
      enqueue(() =>
        appendLine(
          join(directory, 'audit', `${safeName(entry.participantId)}.jsonl`),
          JSON.stringify(entry),
        ),
      ),
  }
}

export class FileStore extends MemoryStore implements Store {
  readonly directory: string
  private readonly queue: WriteQueue

  private constructor(directory: string, state: MemoryState, queue: WriteQueue) {
    super(state, makeFileJournal(directory, queue))
    this.directory = directory
    this.queue = queue
  }

  static async open(directory: string): Promise<FileStore> {
    await mkdir(join(directory, 'collections'), { recursive: true })
    await mkdir(join(directory, 'events'), { recursive: true })
    await mkdir(join(directory, 'audit'), { recursive: true })

    const state = emptyState()
    for (const name of COLLECTIONS) {
      const documents = await readCollection(join(directory, 'collections', name))
      if (name === 'idempotency') {
        for (const record of documents as unknown as IdempotencyRecord[]) {
          state.idempotency.set(record.id, record)
        }
        continue
      }
      const bucket = new Map<string, StoredDocument>()
      for (const document of documents) {
        bucket.set(documentKey(document.participantId, document.id), document)
      }
      state.collections.set(name, bucket)
    }

    await loadEvents(directory, state)
    await loadAttachments(directory, state)
    await loadAudit(directory, state)
    reconcile(state)

    return new FileStore(directory, state, { current: Promise.resolve() })
  }

  /** Waits for every queued write to reach disk. */
  override async close(): Promise<void> {
    await this.queue.current
  }
}

/** Every document under `collections/<name>/<participantId>/*.json`. */
async function readCollection(root: string): Promise<StoredDocument[]> {
  if (!existsSync(root)) return []
  const documents: StoredDocument[] = []
  for (const participantDir of await readdir(root)) {
    const path = join(root, participantDir)
    for (const file of await readdir(path)) {
      if (!file.endsWith('.json')) continue
      const contents = await readFile(join(path, file), 'utf8')
      if (contents.trim() === '') continue
      documents.push(JSON.parse(contents) as StoredDocument)
    }
  }
  return documents
}

async function loadEvents(directory: string, state: MemoryState): Promise<void> {
  const root = join(directory, 'events')
  if (!existsSync(root)) return
  for (const participantDir of await readdir(root)) {
    const events: StoredEvent[] = []
    for (const file of await readdir(join(root, participantDir))) {
      if (!file.endsWith('.jsonl')) continue
      events.push(...(await readLines<StoredEvent>(join(root, participantDir, file))))
    }
    if (events.length === 0) continue
    // Recording order across instances is what the stream cursor replays, and
    // `recordedAt` is the only record of it once the files are separate.
    events.sort((a, b) =>
      a.recordedAt === b.recordedAt
        ? a.header.seq - b.header.seq
        : a.recordedAt.localeCompare(b.recordedAt),
    )
    state.events.set(events[0]!.participantId, events)
  }
}

async function loadAttachments(directory: string, state: MemoryState): Promise<void> {
  const root = join(directory, 'attachments')
  if (!existsSync(root)) return
  for (const participantDir of await readdir(root)) {
    const path = join(root, participantDir)
    for (const file of await readdir(path)) {
      if (!file.endsWith('.json')) continue
      const meta = JSON.parse(await readFile(join(path, file), 'utf8')) as {
        sha256: string
        mime: string
        size: number
        receivedAt: string
      }
      const bytes = await readFile(join(path, file.replace(/\.json$/, '.bin')))
      state.attachments.set(documentKey(participantDir, meta.sha256), {
        ...meta,
        bytes: new Uint8Array(bytes),
      })
    }
  }
}

async function loadAudit(directory: string, state: MemoryState): Promise<void> {
  const root = join(directory, 'audit')
  if (!existsSync(root)) return
  for (const file of await readdir(root)) {
    if (!file.endsWith('.jsonl')) continue
    const entries = await readLines<AuditEntry>(join(root, file))
    if (entries.length === 0) continue
    entries.sort((a, b) => a.seq - b.seq)
    state.audit.set(entries[0]!.participantId, entries)
  }
}

/**
 * Correct any materialised instance that is behind its own log.
 *
 * `appendEvent` writes the event before the instance document, so a crash
 * between the two leaves the cache stale rather than the record incomplete. The
 * log is the truth; this is what makes that statement operational rather than
 * rhetorical.
 */
function reconcile(state: MemoryState): void {
  const instances = state.collections.get('instances')
  if (!instances) return

  for (const [documentKey, document] of instances) {
    const instance = document as InstanceDocument
    const events = (state.events.get(instance.participantId) ?? [])
      .filter((event) => event.header.instance === instance.id)
      .sort((a, b) => a.header.seq - b.header.seq)
    const repaired = reconcileInstance(instance, events)
    if (repaired !== instance) instances.set(documentKey, repaired)
  }
}
