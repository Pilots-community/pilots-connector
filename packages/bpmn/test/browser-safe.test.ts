/**
 * This package is drawn in a browser. The protocol imports `node:crypto`, so a
 * single value import from it would break the process UI's bundle — and would
 * only show up there, not in any test of this package. So it is checked here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : []
  })
}

describe('browser safety', () => {
  it('imports the protocol and zod as types only, and nothing from node', () => {
    const offenders = sources(SRC).filter((path) => {
      const text = readFileSync(path, 'utf8')
      return (
        /^import\s+(?!type\b)[^;]*from\s+'(@pilots\/protocol|zod)'/m.test(text) ||
        /from\s+'node:/.test(text)
      )
    })
    expect(offenders).toEqual([])
  })
})
