/**
 * A stand-in for a participant's own systems.
 *
 * Read what it is allowed to know, because that is the entire claim: a map from
 * transition id to business data its own systems hold. It has **no copy of the
 * definition, no notion of what state the process is in, and no rule about what
 * may follow what.** A notification arrives saying "it is your turn, and here is
 * what you may do"; it posts the transition id straight back.
 *
 * If this file ever needs a state machine, the design has failed at the thing it
 * claims — because then every integrator would need one too, and "a party with
 * no UI is a first-class participant" would be a slogan rather than a fact.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

import {
  ProblemError,
  type PilotsClient,
  type JsonObject,
  type NotificationEnvelope,
} from '@pilots/client'

/**
 * The placeholder a patch uses to refer to the document it is about to attach.
 *
 * A definition typically wants the hash in the data as well as in the header —
 * `certificate: { sha256 }` — and the hash is not known until the bytes are
 * uploaded, because the connector computes it. So the business data says "the
 * document I am attaching" and this substitutes the answer.
 */
export const DOCUMENT_HASH = '__document__'

/** What this business knows, keyed by the transition it might be asked for. */
export interface BusinessData {
  patch?: JsonObject
  /** Bytes to upload and reference, for a transition that requires a document. */
  document?: { content: string; mime: string }
}

export interface BackofficeOptions {
  client: PilotsClient
  data: Record<string, BusinessData>
  /** Shared with the connector, so a webhook on an internal network is still authenticated. */
  secret?: string | undefined
  log?: (message: string, context?: Record<string, unknown>) => void
}

export interface Handled {
  instance: string
  transition: string
  outcome: 'applied' | 'refused' | 'ignored'
  detail?: string
}

export class Backoffice {
  private readonly seen = new Set<string>()

  constructor(private readonly options: BackofficeOptions) {}

  /**
   * A webhook arrives on an internal interface, which does not make it
   * trustworthy. `X-Pilots-Signature` is an HMAC over the exact body with a
   * secret both sides hold, so this can tell its connector from anything else
   * that can reach the port.
   */
  verify(body: string, signature: string | undefined): boolean {
    const secret = this.options.secret
    if (secret === undefined) return true
    if (signature === undefined) return false

    const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    const a = Buffer.from(expected)
    const b = Buffer.from(signature)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /** React to a batch. Anything that is not our turn is simply not our business. */
  async receive(envelopes: readonly NotificationEnvelope[]): Promise<Handled[]> {
    const handled: Handled[] = []
    for (const envelope of envelopes) {
      if (envelope.notification !== 'action.required') continue

      // Delivery is at-least-once, so a duplicate is expected rather than
      // exceptional. The cursor is what makes ignoring one safe.
      if (this.seen.has(envelope.cursor)) continue
      this.seen.add(envelope.cursor)

      handled.push(await this.act(envelope))
    }
    return handled
  }

  private async act(envelope: NotificationEnvelope): Promise<Handled> {
    for (const action of envelope.available) {
      const business = this.options.data[action.transition]
      if (business === undefined) continue

      try {
        const attachments = business.document
          ? [
              await this.options.client.uploadAttachment(
                new TextEncoder().encode(business.document.content),
                business.document.mime,
              ),
            ]
          : undefined

        const patch =
          business.patch === undefined
            ? null
            : attachments?.[0]
              ? (substitute(business.patch, attachments[0].sha256) as JsonObject)
              : business.patch

        await this.options.client.applyTransition(
          envelope.instance.id,
          {
            transition: action.transition,
            patch,
            ...(attachments ? { attachments } : {}),
          },
          // The envelope carried the seq. No read-before-write, no state of our
          // own, and `If-Match` still protects the write.
          envelope.instance.seq,
          // A retry of this notification must not apply the transition twice.
          // The cursor is stable per notification, which is exactly what an
          // idempotency key needs to be.
          { idempotencyKey: `backoffice-${envelope.cursor}` },
        )

        this.options.log?.('applied a transition', {
          instance: envelope.instance.id,
          transition: action.transition,
        })
        return { instance: envelope.instance.id, transition: action.transition, outcome: 'applied' }
      } catch (cause) {
        const detail =
          cause instanceof ProblemError ? `${cause.type}: ${cause.message}` : String(cause)
        this.options.log?.('a transition was refused', {
          instance: envelope.instance.id,
          transition: action.transition,
          detail,
        })
        return {
          instance: envelope.instance.id,
          transition: action.transition,
          outcome: 'refused',
          detail,
        }
      }
    }

    // Our turn, but not for anything this business has data for. A real
    // backoffice would queue it for a person; saying so beats pretending.
    return {
      instance: envelope.instance.id,
      transition: envelope.available.map((one) => one.transition).join(',') || '—',
      outcome: 'ignored',
    }
  }

  /**
   * Catch up on anything missed while this process was down.
   *
   * `GET /notifications?since=` is specified as authoritative precisely so a
   * backoffice that was restarted does not need an operator to notice.
   */
  async catchUp(since?: string): Promise<{ handled: Handled[]; cursor: string | null }> {
    const { notifications, cursor } = await this.options.client.notifications(since, 200)
    return { handled: await this.receive(notifications), cursor }
  }
}

/** Replace every `__document__` with the hash the connector computed. */
function substitute(value: unknown, sha256: string): unknown {
  if (value === DOCUMENT_HASH) return sha256
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, sha256))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substitute(entry, sha256)]),
    )
  }
  return value
}
