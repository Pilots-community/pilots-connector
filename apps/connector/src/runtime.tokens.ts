/**
 * DI tokens for the parts of the runtime a controller injects.
 *
 * They live apart from the services themselves so that `runtime.ts` and the Nest
 * module can both name them without either importing the other — the assembly
 * stays a plain function, and Nest stays a routing layer over it.
 */
export const RELAY = Symbol('PeerRelay')
export const LOCAL_HUB = Symbol('LocalStreamHub')
export const PEER_DELIVERY = Symbol('PeerDeliveryService')
export const REPLICATION = Symbol('ReplicationService')
export const PEER_STREAMS = Symbol('PeerStreamClient')
export const RECOVERY = Symbol('RecoveryService')
