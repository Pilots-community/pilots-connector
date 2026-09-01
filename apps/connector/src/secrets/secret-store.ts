/**
 * The secret store.
 *
 * Two secrets exist at runtime: the participants' Ed25519 signing keys and the
 * API-key pepper. **Neither is ever typed, committed, or passed through a
 * pipeline variable.** If the store has them, they are used; if it does not,
 * they are generated on first boot and written back.
 *
 * That is the whole design, and it is deliberately structural rather than
 * procedural: there is no step in which a human handles a private key, so the
 * rule "never commit a private key" cannot be forgotten. An image with a baked
 * key is a committed key one layer down.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

import type { ParticipantKey } from '@pilots/protocol'

export interface SecretBundle {
  /** Ed25519 key material, keyed by local participant id. */
  signingKeys: Record<string, ParticipantKey>
  /** Server-side pepper for `HMAC-SHA256(pepper, secret)` over API key secrets. */
  apiKeyPepper: string
  /** `HMAC(pepper, adminToken)`. The token itself is shown once and never stored. */
  adminTokenHash: string
}

export interface SecretStore {
  /**
   * Whether generated secrets can be written back. When false, a connector that
   * has to generate them must say out loud that they will not survive a restart.
   */
  readonly persistable: boolean
  load(): Promise<Partial<SecretBundle>>
  /**
   * Merge into what is already there. Two collaborators write this bundle — the
   * signer and the admin session — and neither may erase the other's half.
   */
  save(bundle: Partial<SecretBundle>): Promise<void>
  /** For diagnostics: where these secrets live. Never the values. */
  describe(): string
}

export const SECRET_STORE = Symbol('SecretStore')

/**
 * A JSON file, mode 0600. The default, and what the small-party profile uses:
 * one mounted volume, no secret manager, nothing to configure.
 */
export class FileSecretStore implements SecretStore {
  readonly persistable = true

  constructor(private readonly path: string) {}

  async load(): Promise<Partial<SecretBundle>> {
    if (!existsSync(this.path)) return {}
    const contents = await readFile(this.path, 'utf8')
    if (contents.trim() === '') return {}
    return JSON.parse(contents) as Partial<SecretBundle>
  }

  async save(bundle: Partial<SecretBundle>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const merged = { ...(await this.load()), ...bundle }
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    await chmod(temporary, 0o600)
    await rename(temporary, this.path)
  }

  describe(): string {
    return `file:${this.path}`
  }
}

/**
 * Secrets injected from the environment — what a deployment backed by a real
 * secret manager uses. Read-only by construction: a process cannot write to its
 * own environment in any way that outlives it, and pretending otherwise would
 * hide the fact that generated secrets were about to be lost.
 */
export class EnvSecretStore implements SecretStore {
  readonly persistable = false

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async load(): Promise<Partial<SecretBundle>> {
    const bundle: Partial<SecretBundle> = {}
    const keys = this.env['PILOTS_SIGNING_KEYS']
    if (keys !== undefined && keys.trim() !== '') {
      bundle.signingKeys = JSON.parse(keys) as Record<string, ParticipantKey>
    }
    const pepper = this.env['PILOTS_API_KEY_PEPPER']
    if (pepper !== undefined && pepper.trim() !== '') bundle.apiKeyPepper = pepper
    const adminTokenHash = this.env['PILOTS_ADMIN_TOKEN_HASH']
    if (adminTokenHash !== undefined && adminTokenHash.trim() !== '') {
      bundle.adminTokenHash = adminTokenHash
    }
    return bundle
  }

  async save(): Promise<void> {
    // Deliberately a no-op. The caller checks `persistable` and warns.
  }

  describe(): string {
    return 'env:PILOTS_SIGNING_KEYS,PILOTS_API_KEY_PEPPER,PILOTS_ADMIN_TOKEN_HASH'
  }
}

/** Holds secrets for the life of the process. Tests, and nothing else. */
export class MemorySecretStore implements SecretStore {
  readonly persistable = true
  private bundle: Partial<SecretBundle> = {}

  async load(): Promise<Partial<SecretBundle>> {
    return this.bundle
  }

  async save(bundle: Partial<SecretBundle>): Promise<void> {
    this.bundle = { ...this.bundle, ...bundle }
  }

  describe(): string {
    return 'memory'
  }
}
