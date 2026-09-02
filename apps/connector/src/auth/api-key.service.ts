/**
 * API keys for the integration surface.
 *
 * An API key is a 256-bit CSPRNG secret, not a human password, so it is stored
 * as `HMAC-SHA256(pepper, secret)` rather than under a password KDF. Argon2 and
 * bcrypt exist to slow brute force of *low-entropy* input; against a random
 * 256-bit key they buy nothing, and you would pay their cost on **every API
 * call**. The pepper lives in the secret store, so a store-only compromise
 * yields nothing usable.
 *
 * Presented form: `<keyId>.<secret>`. The separator is a dot because the secret
 * is base64url, which already contains `-` and `_`.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { isUsable, type ApiKeyRecord, type Scope } from '@pilots/protocol'

import type { ApiKeyDocument, Store } from '../store/store.js'

export interface MintedKey {
  record: ApiKeyRecord
  /** Displayed once, at creation, and never retrievable afterwards. */
  secret: string
}

export interface MintRequest {
  participantId: string
  label: string
  scopes: Scope[]
  createdBy: string
  expiresAt?: string | null
}

export type VerifyFailure = 'malformed' | 'unknown' | 'mismatch' | 'revoked' | 'expired'

export type VerifyResult =
  { ok: true; key: ApiKeyDocument } | { ok: false; reason: VerifyFailure; keyId: string | null }

export class ApiKeyService {
  constructor(
    private readonly store: Store,
    private readonly pepper: string,
    private readonly now: () => string,
    private readonly nextId: () => string,
  ) {}

  private hash(secret: string): string {
    return createHmac('sha256', this.pepper).update(secret).digest('hex')
  }

  async mint(request: MintRequest): Promise<MintedKey> {
    const id = `ak_${this.nextId()}`
    const secret = randomBytes(32).toString('base64url')
    const record: ApiKeyDocument = {
      id,
      participantId: request.participantId,
      label: request.label,
      secretHash: this.hash(secret),
      scopes: request.scopes,
      createdBy: request.createdBy,
      createdAt: this.now(),
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: request.expiresAt ?? null,
    }
    await this.store.apiKeys.insert(record)
    return { record, secret: `${id}.${secret}` }
  }

  /**
   * Verify a presented key.
   *
   * Never says *why* to the caller — the reason goes to the application and
   * audit logs, and the caller gets a flat 401. Distinguishing "unknown key"
   * from "wrong secret" is free enumeration.
   */
  /**
   * Register a key whose value was decided outside the connector.
   *
   * **Development only.** The demo hands the same value to a connector and to
   * its co-deployed UI from one `.env` file, so `docker compose up` reaches a
   * working screen without a human minting anything. `loadConfig` refuses it
   * under production config, where an operator mints a key in the admin UI and
   * the value is injected from a secret manager.
   *
   * Idempotent: seeding the same key twice leaves the existing record alone, so
   * a restart neither duplicates nor rotates it.
   */
  async seed(
    presented: string,
    request: Omit<MintRequest, 'createdBy'>,
  ): Promise<ApiKeyDocument | undefined> {
    const separator = presented.indexOf('.')
    if (separator <= 0) return undefined
    const id = presented.slice(0, separator)
    const secret = presented.slice(separator + 1)
    if (secret === '' || !/^ak_[0-9A-HJKMNP-TV-Z]{26}$/i.test(id)) return undefined

    const existing = await this.store.findApiKeyById(id)
    if (existing) return existing

    const record: ApiKeyDocument = {
      id,
      participantId: request.participantId,
      label: request.label,
      secretHash: this.hash(secret),
      scopes: request.scopes,
      createdBy: 'seed',
      createdAt: this.now(),
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: request.expiresAt ?? null,
    }
    await this.store.apiKeys.upsert(record)
    return record
  }

  async verify(presented: string | undefined): Promise<VerifyResult> {
    if (presented === undefined) return { ok: false, reason: 'malformed', keyId: null }

    const separator = presented.indexOf('.')
    if (separator <= 0) return { ok: false, reason: 'malformed', keyId: null }
    const keyId = presented.slice(0, separator)
    const secret = presented.slice(separator + 1)
    if (secret === '') return { ok: false, reason: 'malformed', keyId: null }

    const record = await this.store.findApiKeyById(keyId)
    if (!record) return { ok: false, reason: 'unknown', keyId }

    const expected = Buffer.from(record.secretHash, 'hex')
    const actual = Buffer.from(this.hash(secret), 'hex')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { ok: false, reason: 'mismatch', keyId }
    }

    if (record.revokedAt !== null) return { ok: false, reason: 'revoked', keyId }
    if (!isUsable(record, this.now())) return { ok: false, reason: 'expired', keyId }

    return { ok: true, key: record }
  }

  /** Records that a key was used. Best-effort: it must never fail a request. */
  async touch(key: ApiKeyDocument): Promise<void> {
    await this.store.apiKeys.replace({ ...key, lastUsedAt: this.now() })
  }

  async revoke(participantId: string, id: string): Promise<boolean> {
    const record = await this.store.apiKeys.get(participantId, id)
    if (!record || record.revokedAt !== null) return false
    await this.store.apiKeys.replace({ ...record, revokedAt: this.now() })
    return true
  }

  async list(participantId: string): Promise<ApiKeyDocument[]> {
    return this.store.apiKeys.find(participantId, { sort: { field: 'createdAt' } })
  }

  /** The record as an API may return it: never the hash, never the secret. */
  static redact(record: ApiKeyRecord): Omit<ApiKeyRecord, 'secretHash'> {
    const { secretHash: _omitted, ...rest } = record
    return rest
  }
}
