import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll } from 'vitest'

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
