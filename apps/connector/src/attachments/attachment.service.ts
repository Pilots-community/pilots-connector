/**
 * Content-addressed documents.
 *
 * The event header lists `{ sha256, mime, size }` and the bytes live here. That
 * split keeps the log small, makes documents deduplicated and tamper-evident,
 * and keeps base64 out of the event stream — a peer verifies a chain without
 * ever downloading a PDF, and downloads one knowing exactly what it should hash
 * to.
 *
 * **Who may read a document is derived from `visibility`, never declared
 * separately.** A second place to say who may read a file is a second place for
 * the two to disagree — so the rule is: if the hash appears in your filtered
 * view of the instance data, you may read the bytes. In S1 that is precisely
 * why the shipper can fetch the VGM certificate at `VGM_ISSUED` and not before.
 * See `canReadAttachment` in `@pilots/protocol`.
 *
 * **Bytes follow the reference to the home node.** An actor uploads to its own
 * connector and then names the hash in a transition; the home node pulls what it
 * does not hold from whoever signed the event. Everyone else fetches from the
 * home node. One direction, no loops, and the home node ends up holding the
 * documents for the process it hosts — which is what "the host holds the bytes"
 * already says out loud.
 */
import {
  Problem,
  canReadAttachment,
  homeParticipant,
  protocolError,
  rolesOf,
  sha256 as hashBytes,
  type AttachmentRef,
  type ProtocolError,
} from '@pilots/protocol'

import type { ParticipantConfig } from '../config/config.js'
import type { ConnectionService } from '../connections/connection.service.js'
import type { DefinitionRegistry } from '../definitions/definition-registry.js'
import type { LogService } from '../logging/log.service.js'
import { PeerUnreachableError, type PeerClient } from '../peer/peer-client.js'
import type { Store } from '../store/store.js'
import type { StoredAttachment } from '../store/types.js'

export type AttachmentResult<T> = { ok: true; value: T } | { ok: false; errors: ProtocolError[] }

export class AttachmentService {
  constructor(
    private readonly store: Store,
    private readonly definitions: DefinitionRegistry,
    private readonly connections: ConnectionService,
    private readonly client: PeerClient,
    private readonly log: LogService,
    private readonly now: () => string,
    private readonly maxBytes: number,
    private readonly localParticipants: () => readonly ParticipantConfig[],
  ) {}

  /**
   * The bytes, from **any** local participant that holds them and would serve
   * them to this viewer.
   *
   * The hosted topology, where one connector holds several participants, is the
   * case this exists for: the host and the replica are the same process, and the
   * document sits one collection over. Fetching it back from ourselves over HTTP
   * would be absurd, so we do not — but the entitlement check is the *same* one
   * a peer would face, run against the holder rather than skipped.
   */
  async readLocally(
    viewer: ParticipantConfig,
    sha256: string,
  ): Promise<StoredAttachment | undefined> {
    const own = await this.read(viewer, viewer.did, sha256)
    if (own) return own

    for (const holder of this.localParticipants()) {
      if (holder.id === viewer.id) continue
      if (!(await this.store.attachments.has(holder.id, sha256))) continue
      if (!(await this.entitled(holder, viewer.did, sha256))) continue
      return this.store.attachments.get(holder.id, sha256)
    }
    return undefined
  }

  /**
   * Store bytes and return the reference a transition will carry.
   *
   * The caller does not supply the hash — the connector computes it. A
   * content-addressed store where the content and the address can disagree is
   * not content-addressed.
   */
  async put(
    participant: ParticipantConfig,
    bytes: Uint8Array,
    mime: string,
  ): Promise<AttachmentResult<AttachmentRef>> {
    if (bytes.byteLength === 0) {
      return fail(Problem.attachmentsInvalid, 'an attachment must have some bytes')
    }
    if (bytes.byteLength > this.maxBytes) {
      return fail(
        Problem.attachmentsInvalid,
        `attachment is ${bytes.byteLength} bytes, over the ${this.maxBytes} byte limit`,
      )
    }

    const digest = hashBytes(bytes)
    await this.store.attachments.put(participant.id, {
      sha256: digest,
      mime,
      size: bytes.byteLength,
      bytes,
      receivedAt: this.now(),
    })
    return { ok: true, value: { sha256: digest, mime, size: bytes.byteLength } }
  }

  /**
   * The bytes, if this viewer may read them.
   *
   * `undefined` covers both "no such attachment" and "one you may not see", the
   * same way a `404` does everywhere else: telling those apart is an
   * enumeration oracle, and here it would leak that a document exists at all.
   */
  async read(
    holder: ParticipantConfig,
    viewerDid: string,
    sha256: string,
  ): Promise<StoredAttachment | undefined> {
    if (!(await this.entitled(holder, viewerDid, sha256))) return undefined
    return this.store.attachments.get(holder.id, sha256)
  }

  /**
   * Is this viewer entitled to the bytes?
   *
   * Yes if **any** instance they take part in references the hash and grants
   * them the field that does. Reading it in one instance is enough: the bytes
   * are the same bytes, and refusing them in a second instance would protect
   * nothing while looking as if it did.
   */
  async entitled(holder: ParticipantConfig, viewerDid: string, sha256: string): Promise<boolean> {
    // Reading our own store is not a visibility question. Visibility governs
    // what we hand to *others*; a participant that uploaded a document, or that
    // pulled one as the host of the process it belongs to, holds it outright.
    if (viewerDid === holder.did) {
      return this.store.attachments.has(holder.id, sha256)
    }

    for (const instance of await this.store.instances.find(holder.id)) {
      const roles = rolesOf(instance.participants, viewerDid)
      if (roles.length === 0) continue

      const registered = this.definitions.get(instance.definition)
      if (!registered) continue

      const events = await this.store.events.read(holder.id, instance.id, 0)
      // The reference lives in the header, which is never redacted — so every
      // participant can already see that a document exists. The question is only
      // whether they may read what describes it.
      const referenced = events.some((event) =>
        event.header.attachments.some((ref) => ref.sha256 === sha256),
      )
      if (!referenced) continue

      if (canReadAttachment(registered.definition, instance.data, sha256, roles, instance.state)) {
        return true
      }
    }
    return false
  }

  /**
   * Fetch bytes we do not hold from a peer that should.
   *
   * Used two ways: a home node pulling what an actor referenced, and a replica
   * pulling from the home node so its own integrator can read a document. Both
   * are the same call in opposite directions, which is the point of the surface
   * being symmetric.
   */
  async pull(
    participant: ParticipantConfig,
    peerDid: string,
    refs: readonly AttachmentRef[],
  ): Promise<number> {
    let pulled = 0
    for (const ref of refs) {
      if (await this.store.attachments.has(participant.id, ref.sha256)) continue

      const connection = await this.connections.between(participant.id, peerDid)
      if (!connection) continue

      try {
        const response = await this.client.call(
          participant,
          { did: peerDid, baseUrl: connection.peerBaseUrl },
          {
            method: 'GET',
            path: `/api/peer/v1/attachments/${encodeURIComponent(ref.sha256)}`,
          },
        )
        if (response.status >= 300) continue

        const body = response.body as { sha256?: string; mime?: string; bytes?: string }
        if (typeof body.bytes !== 'string') continue
        const bytes = new Uint8Array(Buffer.from(body.bytes, 'base64'))

        // The peer sent something; whether it sent the *right* something is ours
        // to check. Content addressing is worth nothing if the address is taken
        // on trust.
        if (hashBytes(bytes) !== ref.sha256) {
          await this.log.record({
            level: 'error',
            message: `attachment from ${peerDid} does not hash to what it claims`,
            audit: {
              participantId: participant.id,
              category: 'peer',
              action: 'attachment.pull',
              actor: { kind: 'peer', id: peerDid, actorRef: null },
              outcome: 'failed',
              problem: Problem.attachmentsInvalid,
              detail: `expected ${ref.sha256}`,
            },
          })
          continue
        }

        await this.store.attachments.put(participant.id, {
          sha256: ref.sha256,
          mime: typeof body.mime === 'string' ? body.mime : ref.mime,
          size: bytes.byteLength,
          bytes,
          receivedAt: this.now(),
        })
        pulled += 1
      } catch (cause) {
        // Unreachable now; the reference is still in the log and the bytes are
        // still on the peer. Nothing is lost by trying again later.
        if (!(cause instanceof PeerUnreachableError)) throw cause
      }
    }
    return pulled
  }

  /** The participant that hosts this instance, when it is not one of ours. */
  hostOf(instance: {
    definition: string
    participants: Record<string, unknown>
  }): string | undefined {
    const registered = this.definitions.get(instance.definition)
    if (!registered) return undefined
    return homeParticipant(registered.definition, instance.participants as never)
  }
}

function fail(type: ProtocolError['type'], detail: string): AttachmentResult<never> {
  return { ok: false, errors: [protocolError(type, detail)] }
}

export const ATTACHMENTS = Symbol('AttachmentService')
