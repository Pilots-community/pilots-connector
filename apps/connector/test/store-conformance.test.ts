import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, it } from 'vitest'

import { runStoreConformance } from '../src/store/conformance/suite.js'
import { FileStore } from '../src/store/file/file-store.js'
import { MemoryStore } from '../src/store/memory/memory-store.js'
import type { Store } from '../src/store/store.js'

runStoreConformance('memory', {
  persistent: false,
  create: async () => new MemoryStore(),
  // An in-memory store has no backing storage to reopen, and that is the point:
  // reopening it is starting over.
  reopen: async (store) => {
    await store.close()
    return new MemoryStore()
  },
})

// Temp directories only, per the rule that no test touches a filesystem it does
// not own. One per test, so nothing leaks between them.
const directories: string[] = []
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pilots-store-'))
  directories.push(directory)
  return directory
}

runStoreConformance('file', {
  persistent: true,
  create: () => FileStore.open(freshDirectory()),
  reopen: async (store: Store) => {
    const directory = (store as FileStore).directory
    await store.close()
    return FileStore.open(directory)
  },
})

/**
 * The Mongo adapter, against the **same** suite.
 *
 * Memory and file are both in-process and single-writer, so on their own they
 * cannot fail the two contracts that shape the port — an `appendEvent` with a
 * stale `expectedSeq` and an `Idempotency-Key` claimed twice at once. This
 * adapter can. That is the entire reason it exists at M3 rather than at the end,
 * while the port is still cheap to change.
 *
 * Skipped without `PILOTS_TEST_MONGO_URI`, because `pnpm test` must stay
 * container-free and fast enough to run on save. CI sets it.
 */
const mongoUri = process.env['PILOTS_TEST_MONGO_URI']

if (mongoUri === undefined || mongoUri === '') {
  describe.skip('mongo store conformance (set PILOTS_TEST_MONGO_URI to run)', () => {
    it('is skipped', () => undefined)
  })
} else {
  let database = 0
  runStoreConformance('mongo', {
    persistent: true,
    create: async () => {
      const { MongoStore } = await import('../src/store/mongo/mongo-store.js')
      // A fresh database per case: the suite asserts on empty stores, and a
      // shared one would make the tests order-dependent.
      return MongoStore.open(mongoUri, `pilots_conformance_${(database += 1)}`)
    },
    reopen: async (store: Store) => {
      const { MongoStore } = await import('../src/store/mongo/mongo-store.js')
      const name = (store as { databaseName?: string }).databaseName
      await store.close()
      return MongoStore.open(mongoUri, name ?? `pilots_conformance_${database}`)
    },
  })
}
