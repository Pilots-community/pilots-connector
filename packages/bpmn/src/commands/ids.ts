/**
 * Mirrors `Identifier` in packages/protocol. This package may not import the
 * protocol at runtime (it is drawn in a browser), so the pattern is repeated —
 * and `ids.test.ts` pins it to the spec so the two cannot drift.
 */
export const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]*$/

/** Event `seq` 1 is recorded under this id, so no transition may use it. */
export const RESERVED_TRANSITION = 'create'

export function freshId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`
    if (!used.has(candidate)) return candidate
  }
}

/** A camelCase identifier from a title: "Make an offer" → `makeAnOffer`. */
export function identifierFrom(title: string, taken: Iterable<string>, fallback = 'step'): string {
  const words = title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
  const camel = words
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`,
    )
    .join('')
  const base = IDENTIFIER.test(camel) ? camel : fallback
  return freshId(base === RESERVED_TRANSITION ? `${base}Step` : base, taken)
}

/** The next patch version, for "New version" and for a publish that met a conflict. */
export function bumpVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return match === null ? version : `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}
