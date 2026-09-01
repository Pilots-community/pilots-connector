/**
 * Canonicalisation and hashing.
 *
 * Every hash and every signature in this protocol is taken over the JCS
 * (RFC 8785) form of a document, never over whatever byte sequence a particular
 * JSON serialiser happened to produce. Skipping this is the classic
 * cross-implementation interop bug: it works perfectly until a second
 * implementation exists.
 *
 * The same two primitives serve three chains — the event chain, the audit chain,
 * and content-addressed attachments — which is why they live alone in this file.
 */
import { createHash } from 'node:crypto'

import canonicalize from 'canonicalize'

import type { JsonValue } from './json.js'

/** A `sha256:<64 lowercase hex chars>` digest string. */
export type Sha256 = string

const utf8 = new TextEncoder()

/** The JCS (RFC 8785) serialisation of a JSON value. */
export function canonicalise(value: JsonValue): string {
  const serialised = canonicalize(value)
  if (serialised === undefined) {
    throw new TypeError('value is not canonicalisable: it is not a JSON value')
  }
  return serialised
}

/** The JCS serialisation as UTF-8 bytes — what actually gets hashed and signed. */
export function canonicalBytes(value: JsonValue): Uint8Array {
  return utf8.encode(canonicalise(value))
}

/** `sha256:<hex>` over raw bytes, or over the UTF-8 encoding of a string. */
export function sha256(input: Uint8Array | string): Sha256 {
  const bytes = typeof input === 'string' ? utf8.encode(input) : input
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** `sha256:<hex>` over the canonical form of a JSON value. */
export function hashJson(value: JsonValue): Sha256 {
  return sha256(canonicalBytes(value))
}

/**
 * The `payloadHash` of an event that carries no payload. A transition may change
 * state without touching data, and the header still has to commit to something.
 */
export const EMPTY_PAYLOAD_HASH: Sha256 = hashJson({})

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/

export function isSha256(value: unknown): value is Sha256 {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}
