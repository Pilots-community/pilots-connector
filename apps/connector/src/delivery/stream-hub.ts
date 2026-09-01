/**
 * Held-open streams, for peers and for local subscribers alike.
 *
 * **A stream here is a pull loop with a wake-up, not a broadcast.** Each
 * listener owns a cursor and asks for "everything after this"; a write nudges it
 * to ask again. That is one code path for catch-up and for live traffic, so the
 * two cannot disagree about ordering, and there is no window between "replay
 * finished" and "live started" for an event to fall into.
 *
 * The alternative — push live events at attached listeners and replay history
 * separately — needs a buffer, a de-duplication set, and a careful argument
 * about registration order. It is also silently wrong when it breaks: a stream
 * that occasionally loses one event looks exactly like a stream that works.
 *
 * One implementation for both sides of the connector because the rule is the
 * same on both, and it is the rule that lets a party with no inbound endpoint
 * take part: dial out, hold the line, and on reconnect say where you got to.
 */
import type { StreamMessage } from '../peer/transport.js'

export interface StreamHandlers {
  onMessage: (message: StreamMessage) => void
  onClose?: (reason: string) => void
}

/** Everything after `since`, oldest first. `null` means "from the beginning". */
export type StreamPull = (since: string | null) => Promise<StreamMessage[]>

interface Listener {
  participantId: string
  /** The peer's DID, or a local subscription id. */
  audience: string
  handlers: StreamHandlers
  pull: StreamPull
  cursor: string | null
  draining: boolean
  /** A wake-up that arrived mid-drain. One re-run covers any number of them. */
  pending: boolean
  closed: boolean
}

export interface StreamAttachment {
  close(): void
  /** How far this listener has been sent. Its `Last-Event-ID`, from our side. */
  readonly cursor: string | null
}

export class StreamHub {
  private readonly listeners = new Set<Listener>()

  /**
   * Attach a subscriber and send it everything after the cursor it reported.
   *
   * Returns once the catch-up has been delivered, so a caller — or a test — can
   * rely on "attached" meaning "converged".
   */
  async attach(options: {
    participantId: string
    audience: string
    handlers: StreamHandlers
    /** What the subscriber last saw, from `Last-Event-ID` or `?since=`. */
    since?: string | null
    pull: StreamPull
  }): Promise<StreamAttachment> {
    const listener: Listener = {
      participantId: options.participantId,
      audience: options.audience,
      handlers: options.handlers,
      pull: options.pull,
      cursor: options.since ?? null,
      draining: false,
      pending: false,
      closed: false,
    }
    this.listeners.add(listener)

    const attachment: StreamAttachment = {
      close: () => {
        if (listener.closed) return
        listener.closed = true
        this.listeners.delete(listener)
      },
      get cursor() {
        return listener.cursor
      },
    }

    try {
      await this.drain(listener)
    } catch (cause) {
      attachment.close()
      throw cause
    }
    return attachment
  }

  /**
   * Something was written: let the matching listeners catch up.
   *
   * Awaited rather than fire-and-forget, so a scenario test does not need a
   * sleep to know delivery has happened. In production the caller is already in
   * an async path and the cost is one store read per attached peer.
   */
  async wake(participantId: string, audience?: string): Promise<void> {
    const targets = [...this.listeners].filter(
      (listener) =>
        listener.participantId === participantId &&
        (audience === undefined || listener.audience === audience),
    )
    await Promise.all(targets.map((listener) => this.drain(listener)))
  }

  /**
   * Serialised per listener: a second wake-up while one is in flight sets a flag
   * rather than starting a concurrent read. Two overlapping drains would
   * interleave messages and hand the subscriber events out of order.
   */
  private async drain(listener: Listener): Promise<void> {
    if (listener.draining) {
      listener.pending = true
      return
    }
    listener.draining = true
    try {
      do {
        listener.pending = false
        for (;;) {
          if (listener.closed) return
          const messages = await listener.pull(listener.cursor)
          if (messages.length === 0) break
          for (const message of messages) {
            if (listener.closed) return
            listener.handlers.onMessage(message)
            listener.cursor = message.id
          }
        }
      } while (listener.pending)
    } finally {
      listener.draining = false
    }
  }

  /** Whether anyone is listening. A `stream` peer that is not gets nothing, and pulls later. */
  attached(participantId: string, audience: string): boolean {
    for (const listener of this.listeners) {
      if (listener.participantId === participantId && listener.audience === audience) return true
    }
    return false
  }

  /** Drop every stream: what a shutdown does, and what a test uses to simulate one. */
  closeAll(reason = 'the connector is shutting down'): void {
    for (const listener of [...this.listeners]) {
      listener.closed = true
      this.listeners.delete(listener)
      listener.handlers.onClose?.(reason)
    }
  }

  get size(): number {
    return this.listeners.size
  }
}
