/**
 * The audit chain.
 *
 * The same `sha256`-of-JCS primitive as the event chain, applied to a second,
 * quite different log: append-only, **unsigned**, and **never replicated**.
 *
 * It costs one call to primitives that already exist and buys tamper evidence on
 * your own administrative trail with no key ceremony at all. Signing it would be
 * the wrong trade — nobody outside this connector ever reads it, so there is no
 * counterparty to convince, only your own operators and auditors.
 */
import { hashJson, type Sha256 } from '../canonical.js'
import { Problem, protocolError, type ProtocolError } from '../problems.js'
import { AuditEntry, EMPTY_AUDIT_SUBJECT, type AuditSubject } from '../schemas/audit.js'

/** Everything but the two fields the chain itself assigns. */
export type AuditEntryDraft = Omit<AuditEntry, 'seq' | 'prev' | 'subject'> & {
  subject?: Partial<AuditSubject>
}

export function auditEntryHash(entry: AuditEntry): Sha256 {
  return hashJson(entry)
}

/** Append one entry to the chain, assigning its `seq` and `prev`. */
export function chainAuditEntry(draft: AuditEntryDraft, previous: AuditEntry | null): AuditEntry {
  return AuditEntry.parse({
    ...draft,
    subject: { ...EMPTY_AUDIT_SUBJECT, ...draft.subject },
    seq: previous === null ? 1 : previous.seq + 1,
    prev: previous === null ? null : auditEntryHash(previous),
  })
}

export interface AuditChainVerification {
  ok: boolean
  failures: Array<{ seq: number; error: ProtocolError }>
}

/** Confirm nobody has edited, reordered or removed an entry. */
export function verifyAuditChain(entries: readonly AuditEntry[]): AuditChainVerification {
  const failures: AuditChainVerification['failures'] = []
  let previous: AuditEntry | null = null

  for (const [index, entry] of entries.entries()) {
    const expectedSeq = index + 1
    if (entry.seq !== expectedSeq) {
      failures.push({
        seq: entry.seq,
        error: protocolError(
          Problem.chainBroken,
          `expected audit seq ${expectedSeq}, got ${entry.seq}`,
        ),
      })
      break
    }
    const expectedPrev = previous === null ? null : auditEntryHash(previous)
    if (entry.prev !== expectedPrev) {
      failures.push({
        seq: entry.seq,
        error: protocolError(
          Problem.chainBroken,
          previous === null
            ? 'the first audit entry must have prev: null'
            : `audit entry ${entry.seq} does not chain to entry ${previous.seq}`,
        ),
      })
      break
    }
    previous = entry
  }

  return { ok: failures.length === 0, failures }
}
