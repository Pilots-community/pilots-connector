/**
 * The committed OpenAPI document must match what the code generates.
 *
 * Same discipline as the protocol's JSON Schema export, and for the same reason:
 * somebody generated a client from that file. A route added without exporting it
 * should fail the build, not ship a contract that quietly disagrees with the
 * connector.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { localApiDocument } from '../src/openapi.js'

const here = dirname(fileURLToPath(import.meta.url))
interface Operation {
  parameters?: Array<{ name: string; required?: boolean }>
}
interface Document {
  paths: Record<string, Record<string, Operation>>
  [key: string]: unknown
}

const committed = JSON.parse(readFileSync(join(here, '..', 'openapi.json'), 'utf8')) as Document

describe('the committed OpenAPI document', () => {
  it('is up to date', () => {
    expect(committed).toEqual(localApiDocument())
  })

  it('describes the whole local API and nothing else', () => {
    const paths = Object.keys(committed.paths).sort()
    expect(paths).toEqual([
      '/attachments',
      '/attachments/{sha256}',
      '/connections',
      '/definitions',
      '/definitions/{ref}',
      '/events',
      '/instances',
      '/instances/{id}',
      '/instances/{id}/events',
      '/instances/{id}/transitions',
      '/me',
      '/notifications',
      '/offerings',
    ])
  })

  it('makes If-Match required on the one mutating call', () => {
    const transition = committed.paths['/instances/{id}/transitions']?.['post']
    const ifMatch = transition?.parameters?.find((one) => one.name === 'If-Match')
    // Optional would be a silent overwrite waiting to happen; the connector
    // answers 428 without it, and the document has to say so.
    expect(ifMatch?.required).toBe(true)
  })

  it('exposes no route a peer or an operator would use', () => {
    const document = JSON.stringify(committed)
    expect(document).not.toContain('/api/peer/')
    expect(document).not.toContain('/api/admin/')
    // Connections are readable so a client can explain a refusal, never writable.
    expect(Object.keys(committed.paths['/connections'] ?? {})).toEqual(['get'])
  })
})
