import { EMPTY_PAYLOAD_HASH } from '../../src/canonical.js'
import { genesisHash, headerHash, signEvent } from '../../src/engine/chain.js'
import { LocalEd25519Signer } from '../../src/crypto/local-signer.js'
import type { JsonObject } from '../../src/json.js'
import {
  staticDidResolver,
  type DidDocument,
  type DidResolver,
} from '../../src/ports/did-resolver.js'
import type { AttachmentRef } from '../../src/schemas/common.js'
import type { SignedEvent } from '../../src/schemas/event.js'
import { instanceGenesis, type InstanceGenesis } from '../../src/schemas/instance.js'

export const ACME = 'did:web:acme-shipping.example'
export const VANMOER = 'did:web:vanmoer.example'

export interface TwoParties {
  signer: LocalEd25519Signer
  resolver: DidResolver
  documents: Record<string, DidDocument>
}

/** Two participants with freshly generated keys. No key is ever a fixture. */
export async function twoParties(): Promise<TwoParties> {
  const signer = await LocalEd25519Signer.generate({ acme: ACME, vanmoer: VANMOER })
  const documents = {
    [ACME]: await signer.didDocument('acme'),
    [VANMOER]: await signer.didDocument('vanmoer'),
  }
  return { signer, resolver: staticDidResolver(documents), documents }
}

export interface AppendSpec {
  participantId: 'acme' | 'vanmoer'
  actor: string
  transition: string
  from: string | null
  to: string | null
  at: string
  payload?: JsonObject | null
  attachments?: AttachmentRef[]
}

/**
 * A default identity for logs whose test does not care about one. Real
 * verification pins it; these helpers only need every event in a log to agree.
 */
export const DEFAULT_GENESIS: InstanceGenesis = instanceGenesis({
  kind: 'service',
  definition: 'container-weighing@1.0.0',
  participants: { shipper: ACME, weigher: VANMOER },
})

/** Build a signed, chained log the way a home node would. */
export class ChainBuilder {
  readonly events: SignedEvent[] = []
  readonly genesis: InstanceGenesis

  constructor(
    private readonly parties: TwoParties,
    private readonly instanceId: string,
    genesis: InstanceGenesis = DEFAULT_GENESIS,
  ) {
    this.genesis = genesis
  }

  async append(spec: AppendSpec): Promise<SignedEvent> {
    const previous = this.events.at(-1)
    const event = await signEvent(this.parties.signer, spec.participantId, {
      instance: this.instanceId,
      genesis: genesisHash(this.genesis),
      seq: this.events.length + 1,
      transition: spec.transition,
      actor: spec.actor,
      from: spec.from,
      to: spec.to,
      at: spec.at,
      prev: previous ? headerHash(previous.header) : null,
      payload: spec.payload ?? null,
      attachments: spec.attachments ?? [],
    })
    this.events.push(event)
    return event
  }
}

export { EMPTY_PAYLOAD_HASH }
