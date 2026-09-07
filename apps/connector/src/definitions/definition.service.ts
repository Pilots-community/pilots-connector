/**
 * Authoring and adopting process definitions at runtime.
 *
 * Two different acts live here, and the difference matters:
 *
 * - **Publishing** is an ordinary integration act. A participant authors a
 *   process and publishes it on `/api/local/v1`, the same surface any third
 *   party's UI or build pipeline can use. Nobody has to agree to it, because it
 *   is ours.
 * - **Adopting** is a trust decision about somebody *else's* process, and it is
 *   decided once per definition rather than once per instance. The decision is
 *   recorded against the ref and consulted forever after.
 *
 * A published definition is immutable and content-addressed. Publishing the
 * same bytes twice is a no-op; publishing *different* bytes under an existing
 * `id@version` is a conflict, not an update. A version is an identity — an
 * instance is pinned to one for its whole life, and a peer adopts one by hash.
 */
import {
  Problem,
  diffDefinitions,
  formatDiagnostic,
  hashJson,
  protocolError,
  type DefinitionChange,
  type JsonValue,
  type LintResult,
  type ProtocolError,
} from '@pilots/protocol'

import {
  DefinitionLoadError,
  DefinitionRegistry,
  type RegisteredDefinition,
} from './definition-registry.js'
import {
  byVersionDescending,
  definitionDocumentOf,
  isUsable,
  type AdoptionStatus,
  type DefinitionAdoption,
  type DefinitionDocument,
} from './definition-store.js'
import type { PeerClient } from '../peer/peer-client.js'
import type { ParticipantConfig } from '../config/config.js'
import type { Store } from '../store/store.js'

export interface PublishOutcome {
  registered: RegisteredDefinition
  /** False when the identical document was already published: an idempotent repeat. */
  created: boolean
}

/** A peer's definition awaiting an operator's decision, with what changed. */
export interface PendingDefinition {
  document: DefinitionDocument
  /** The highest already-accepted version of the same definition, if any. */
  diffAgainst: string | null
  changes: DefinitionChange[]
  /** Warnings the linter raised. Not errors — those never get this far. */
  warnings: string[]
}

/**
 * Whether a definition may govern an instance, from the point of view of a
 * delivery that has just arrived under it.
 */
export type DefinitionAvailability =
  | { status: 'usable' }
  /** Held, awaiting an operator. The delivery should be retried, not failed. */
  | { status: 'pending'; ref: string }
  /** An operator said no. Retrying will never help. */
  | { status: 'rejected'; detail: string }
  /** Could not be obtained at all: no connection, bad bytes, or it does not lint. */
  | { status: 'unavailable'; detail: string }

type Result<T> = { ok: true; value: T } | { ok: false; errors: ProtocolError[] }

const ok = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = (type: ProtocolError['type'], detail: string, pointer?: string): Result<never> => ({
  ok: false,
  errors: [protocolError(type, detail, pointer)],
})

export class DefinitionService {
  constructor(
    private readonly store: Store,
    private readonly registry: DefinitionRegistry,
    private readonly client: PeerClient,
    private readonly now: () => string,
  ) {}

  /** Validate a candidate document and hold nothing. What the editor calls on every keystroke. */
  lint(raw: unknown): LintResult {
    return DefinitionRegistry.lint(raw)
  }

  async publish(participantId: string, raw: JsonValue): Promise<Result<PublishOutcome>> {
    let registered: RegisteredDefinition
    try {
      registered = DefinitionRegistry.register(raw, 'local')
    } catch (cause) {
      if (!(cause instanceof DefinitionLoadError)) throw cause
      return fail(
        Problem.definitionInvalid,
        cause.diagnostics.map(formatDiagnostic).join('; '),
        '/definition',
      )
    }

    const existing = await this.store.definitions.get(participantId, registered.ref)
    if (existing) {
      if (existing.contentHash === registered.contentHash) {
        // Idempotent: the same document, published twice.
        return ok({ registered, created: false })
      }
      return fail(
        Problem.definitionConflict,
        `${registered.ref} is already published with different content. A published definition never changes — instances are pinned to it and peers adopt it by hash — so bump the version instead.`,
        '/definition/version',
      )
    }

    await this.store.definitions.insert(
      definitionDocumentOf(participantId, registered, 'local', null, this.now()),
    )
    this.registry.adopt(registered)
    return ok({ registered, created: true })
  }

  /**
   * Fetch a definition a peer's delivery referred to, and hold it pending.
   *
   * The bytes are checked against the hash the instance's genesis pins, so a
   * peer cannot hand over a different document than the one its own instances
   * are signed against. That check is the reason `definitionHash` is in the
   * genesis at all.
   */
  async fetchFromPeer(
    participant: ParticipantConfig,
    peer: { did: string; baseUrl: string },
    ref: string,
    expectedHash: string,
  ): Promise<Result<DefinitionDocument>> {
    const response = await this.client.call(participant, peer, {
      method: 'GET',
      path: `/api/peer/v1/definitions/${encodeURIComponent(ref)}`,
    })

    if (response.status >= 300) {
      return fail(
        Problem.peerResponseInvalid,
        `${peer.did} answered ${response.status} for definition ${ref}`,
      )
    }

    const body = response.body as { definition?: JsonValue } | null
    const raw = body?.definition
    if (raw === undefined) {
      return fail(Problem.peerResponseInvalid, `${peer.did} returned no definition for ${ref}`)
    }

    // Before linting: if the bytes are not the ones the chain commits to,
    // nothing else about this document is worth considering.
    const actualHash = hashJson(raw)
    if (actualHash !== expectedHash) {
      return fail(
        Problem.definitionInvalid,
        `${peer.did} returned a document for ${ref} whose hash (${actualHash}) is not the one this instance is signed against (${expectedHash})`,
      )
    }

    let registered: RegisteredDefinition
    try {
      registered = DefinitionRegistry.register(raw, `peer:${peer.did}`)
    } catch (cause) {
      if (!(cause instanceof DefinitionLoadError)) throw cause
      return fail(
        Problem.definitionInvalid,
        `${ref} from ${peer.did} does not lint: ${cause.diagnostics.map(formatDiagnostic).join('; ')}`,
      )
    }

    if (registered.ref !== ref) {
      return fail(
        Problem.definitionInvalid,
        `${peer.did} returned ${registered.ref} when asked for ${ref}`,
      )
    }

    const adoption: DefinitionAdoption = {
      status: 'pending',
      peerDid: peer.did,
      decidedAt: null,
      decidedBy: null,
      reason: null,
    }
    const document = definitionDocumentOf(participant.id, registered, 'peer', adoption, this.now())
    await this.store.definitions.upsert(document)

    /*
     * Register it now, while it is still pending.
     *
     * Holding a definition and agreeing to run it are different things: the
     * **adoption record** is the gate, and `acquire` consults it before it
     * consults the registry. Registering only on acceptance would mean an
     * operator could accept a document the engine had never parsed, and the
     * accept path would have to re-lint and re-register to compensate.
     */
    this.registry.adopt(registered)
    return ok(document)
  }

  /**
   * Make a definition a peer's delivery referred to usable, or say why not.
   *
   * The four answers are the four situations, and they are deliberately not
   * collapsed into ok/error: a *pending* adoption is a wait — the delivery will
   * succeed once an operator accepts — while a *rejected* one never will, and
   * the delivery path treats those very differently.
   */
  async acquire(
    participant: ParticipantConfig,
    peerDid: string,
    ref: string,
    expectedHash: string,
  ): Promise<DefinitionAvailability> {
    const held = await this.store.definitions.get(participant.id, ref)

    if (held) {
      if (isUsable(held)) return { status: 'usable' }
      if (held.adoption?.status === 'rejected') {
        return {
          status: 'rejected',
          detail: held.adoption.reason ?? `${ref} was refused by an operator here`,
        }
      }
      return { status: 'pending', ref }
    }

    // Registered from the boot directory but never stored: the seed case. It is
    // ours by an operator's choice, so nobody has to agree to it.
    if (this.registry.has(ref)) return { status: 'usable' }

    const connection = (
      await this.store.connections.find(participant.id, { where: { peerDid } })
    )[0]
    if (!connection) {
      return {
        status: 'unavailable',
        detail: `no connection to ${peerDid}, so ${ref} cannot be fetched`,
      }
    }

    const fetched = await this.fetchFromPeer(
      participant,
      { did: peerDid, baseUrl: connection.peerBaseUrl },
      ref,
      expectedHash,
    )
    if (!fetched.ok) {
      return {
        status: 'unavailable',
        detail: fetched.errors[0]?.detail ?? `${ref} could not be fetched from ${peerDid}`,
      }
    }
    return { status: 'pending', ref }
  }

  /** What this participant holds, and whether each may govern an instance. */
  async held(participantId: string): Promise<DefinitionDocument[]> {
    return this.store.definitions.find(participantId)
  }

  /** Whether a ref may govern an instance right now, and why not if it may not. */
  async adoptionOf(participantId: string, ref: string): Promise<DefinitionDocument | undefined> {
    return this.store.definitions.get(participantId, ref)
  }

  /**
   * Definitions awaiting a decision, each with a diff against the version this
   * participant last accepted.
   *
   * An operator approving `1.1.0` is answering "what changed since the `1.0.0`
   * I already agreed to", which a raw text diff answers badly.
   */
  async pending(participantId: string): Promise<PendingDefinition[]> {
    const held = await this.store.definitions.find(participantId)
    const pending = held.filter((one) => one.adoption?.status === 'pending')

    return pending.map((document) => {
      const accepted = byVersionDescending(
        held.filter(
          (one) =>
            one.definitionId === document.definitionId && one.ref !== document.ref && isUsable(one),
        ),
      )[0]

      const registered = this.registry.get(document.ref)
      const previous = accepted ? this.registry.get(accepted.ref) : undefined

      return {
        document,
        diffAgainst: accepted?.ref ?? null,
        changes:
          previous && registered ? diffDefinitions(previous.definition, registered.definition) : [],
        warnings: (registered?.warnings ?? []).map(formatDiagnostic),
      }
    })
  }

  /** Accept or reject a peer's definition. Decided once; consulted forever after. */
  async decide(
    participantId: string,
    ref: string,
    status: Exclude<AdoptionStatus, 'pending'>,
    decidedBy: string,
    reason: string | null = null,
  ): Promise<Result<DefinitionDocument>> {
    const document = await this.store.definitions.get(participantId, ref)
    if (!document) return fail(Problem.definitionInvalid, `no definition ${ref} is held`)
    if (document.adoption === null) {
      return fail(
        Problem.definitionInvalid,
        `${ref} was not received from a peer, so there is nothing to decide`,
      )
    }

    const updated: DefinitionDocument = {
      ...document,
      adoption: {
        ...document.adoption,
        status,
        decidedAt: this.now(),
        decidedBy,
        reason,
      },
    }
    await this.store.definitions.replace(updated)

    /*
     * Nothing to do to the registry: the document was registered when it
     * arrived. What changed is whether anyone agreed to it, and that lives in
     * the adoption record `acquire` reads.
     */
    return ok(updated)
  }
}

export const DEFINITIONS = Symbol('DefinitionService')
