/**
 * `NotificationChannel` — how a notification reaches your own systems.
 *
 * This is *local* delivery: connector to backoffice. It is configuration, not
 * protocol, and the peer on the other side of a process neither knows nor cares
 * about it. Do not conflate it with peer delivery, which is declared on a
 * connection and carries signed events between connectors.
 *
 * The port exists so that **adding a queue adapter later changes nothing else**.
 * If SQS or AMQP arrives and subscriptions, notification types or the envelope
 * have to change to accommodate it, this model was wrong. Everything a channel
 * needs is in its arguments; nothing about queues is designed for here, which is
 * the point.
 */
import { createHmac } from 'node:crypto'

import type { NotificationEnvelope, NotificationSubscription } from '@pilots/protocol'

export interface NotificationChannel {
  readonly name: string
  /**
   * Deliver a batch, in order. Throwing means "not delivered" and earns a
   * retry; returning means the batch is done.
   */
  deliver(
    subscription: NotificationSubscription,
    envelopes: readonly NotificationEnvelope[],
  ): Promise<void>
}

/** What a webhook target's secret reference resolves to, if anything. */
export type SecretResolver = (ref: string) => string | undefined

/**
 * The `post` a webhook channel performs, as a port.
 *
 * Injected rather than calling `fetch` directly so that a scenario test can
 * exercise the **real** channel — headers, batching, HMAC and all — without a
 * webhook receiver. A test that swapped the whole channel out would prove the
 * envelope was built and nothing about how it is signed.
 */
export type HttpPost = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<{ status: number }>

export const fetchPost: HttpPost = async (url, headers, body) => {
  const response = await fetch(url, { method: 'POST', headers, body })
  return { status: response.status }
}

export class WebhookDeliveryError extends Error {
  constructor(readonly status: number) {
    super(`the target answered ${status}`)
    this.name = 'WebhookDeliveryError'
  }
}

/**
 * POST the envelope batch to the subscription's target.
 *
 * `X-Pilots-Signature` is an HMAC over the exact body, so an internal system can
 * authenticate the caller across its own network — a webhook that arrives on an
 * internal interface is not thereby trustworthy.
 */
export class WebhookChannel implements NotificationChannel {
  readonly name = 'webhook'

  constructor(
    private readonly post: HttpPost = fetchPost,
    private readonly secrets: SecretResolver = resolveEnvSecret,
  ) {}

  async deliver(
    subscription: NotificationSubscription,
    envelopes: readonly NotificationEnvelope[],
  ): Promise<void> {
    const target = subscription.target
    if (!target) throw new Error(`subscription ${subscription.id} has no webhook target`)

    const body = JSON.stringify({ notifications: envelopes })
    const headers: Record<string, string> = {
      ...target.headers,
      'content-type': 'application/json',
      'x-pilots-subscription': subscription.id,
    }

    const secret = target.secretRef === null ? undefined : this.secrets(target.secretRef)
    if (secret !== undefined) {
      headers['x-pilots-signature'] =
        `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    }

    const response = await this.post(target.url, headers, body)
    if (response.status >= 300) throw new WebhookDeliveryError(response.status)
  }
}

/** `env:NAME` resolves from the environment. The reference is stored; the value never is. */
export function resolveEnvSecret(ref: string): string | undefined {
  if (!ref.startsWith('env:')) return undefined
  return process.env[ref.slice('env:'.length)]
}

/**
 * The `sse` channel: hand the envelope to whoever is holding the local stream.
 *
 * A delivery here never *fails*. If nobody is attached the envelope is simply
 * not pushed, and the subscriber picks it up from its cursor when it comes back
 * — the same recovery shape as a peer reattaching with `Last-Event-ID`. Treating
 * "nobody was listening" as a failure would dead-letter every notification
 * written while a backoffice was restarting.
 */
export class SseChannel implements NotificationChannel {
  readonly name = 'sse'

  constructor(
    private readonly publish: (
      subscription: NotificationSubscription,
      envelope: NotificationEnvelope,
    ) => void,
  ) {}

  async deliver(
    subscription: NotificationSubscription,
    envelopes: readonly NotificationEnvelope[],
  ): Promise<void> {
    for (const envelope of envelopes) this.publish(subscription, envelope)
  }
}

/** The test double [TESTING.md §2](../../../../docs/TESTING.md) names: an in-memory collector. */
export class CollectingChannel implements NotificationChannel {
  readonly received: { subscription: string; envelope: NotificationEnvelope }[] = []
  /** Set to make the next `deliver` throw, so retry and dead-lettering are testable. */
  failures = 0

  constructor(readonly name: string = 'webhook') {}

  async deliver(
    subscription: NotificationSubscription,
    envelopes: readonly NotificationEnvelope[],
  ): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1
      throw new Error('the collector was told to fail')
    }
    for (const envelope of envelopes) {
      this.received.push({ subscription: subscription.id, envelope })
    }
  }

  ofType(type: string): NotificationEnvelope[] {
    return this.received
      .filter((entry) => entry.envelope.notification === type)
      .map((entry) => entry.envelope)
  }

  clear(): void {
    this.received.length = 0
  }
}
