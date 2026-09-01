/**
 * Human-readable titles for the problem types.
 *
 * Split out from `problem.ts` so the peer surface can produce RFC 7807 without
 * importing Nest. That surface is called directly by the in-process transport in
 * every scenario test, and dragging a framework in behind it would make the
 * hermetic tier load an HTTP stack it never uses.
 */
import { Problem } from '@pilots/protocol'

const TITLES: Record<string, string> = {
  [Problem.unknownTransition]: 'Unknown transition',
  [Problem.roleNotPermitted]: 'Role not permitted',
  [Problem.illegalState]: 'Illegal state',
  [Problem.instanceTerminal]: 'Instance is terminal',
  [Problem.schemaInvalid]: 'Schema validation failed',
  [Problem.guardFailed]: 'Guard failed',
  [Problem.attachmentsInvalid]: 'Attachments invalid',
  [Problem.notAParticipant]: 'Not a participant',
  [Problem.definitionInvalid]: 'Definition invalid',
  [Problem.seqConflict]: 'Sequence conflict',
  [Problem.preconditionRequired]: 'Precondition required',
  [Problem.credentialInvalid]: 'Invalid credential',
  [Problem.scopeMissing]: 'Missing scope',
  [Problem.connectionNotActive]: 'Connection not active',
  [Problem.chainBroken]: 'Chain broken',
  [Problem.signatureInvalid]: 'Signature invalid',
  [Problem.payloadHashMismatch]: 'Payload hash mismatch',
  [Problem.peerUnreachable]: 'Peer unreachable',
  [Problem.peerResponseInvalid]: 'Peer response invalid',
}

export function titleFor(type: string): string {
  return TITLES[type] ?? 'Request failed'
}
