/**
 * Guidance, validation and sample data — all derived from the schema.
 *
 * Nothing here knows what a container number or a gross mass is, for the same
 * reason `SchemaForm` does not: a table of known field names would be a list to
 * keep in step with every definition anybody writes, and the whole claim is that
 * a new definition needs no UI work.
 *
 * `now` and `random` are parameters rather than globals, so the output is
 * checkable in a test instead of merely plausible on screen — the same reason
 * `Clock` and `IdGenerator` are ports in the connector.
 */
import type { JsonSchema } from './json-schema.js'

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGITS = '0123456789'

/** One segment of a pattern we understand: a character class and a repeat count. */
interface Segment {
  alphabet: string
  count: number
}

/**
 * Read a *simple* anchored pattern into segments.
 *
 * Deliberately tiny. It covers `[A-Z]{4}[0-9]{7}` and `[A-Z]{3}`, which is every
 * pattern the shipped definitions use, and returns `null` for anything with
 * alternation, look-around or optionality. Returning `null` matters more than
 * covering more: a generator that guesses at a pattern it does not understand
 * produces a value the connector then refuses, which is worse than leaving the
 * field for a person.
 */
function parsePattern(pattern: string): Segment[] | null {
  const body = pattern.replace(/^\^/, '').replace(/\$$/, '')
  const segments: Segment[] = []
  const token = /^(?:\[A-Z\]|\[0-9\]|\[A-Za-z\]|\\d)(?:\{(\d+)\})?/

  let rest = body
  while (rest.length > 0) {
    const match = token.exec(rest)
    if (!match) return null
    const alphabet = rest.startsWith('[A-Z]')
      ? LETTERS
      : rest.startsWith('[A-Za-z]')
        ? LETTERS
        : DIGITS
    segments.push({ alphabet, count: Number(match[1] ?? 1) })
    rest = rest.slice(match[0].length)
  }
  return segments.length > 0 ? segments : null
}

function describeSegments(segments: Segment[]): string {
  return segments
    .map(({ alphabet, count }) => (alphabet === LETTERS ? `${count} letters` : `${count} digits`))
    .join(', then ')
}

function fromSegments(segments: Segment[], random: () => number): string {
  return segments
    .map(({ alphabet, count }) =>
      Array.from(
        { length: count },
        () => alphabet[Math.floor(random() * alphabet.length)] ?? alphabet[0],
      ).join(''),
    )
    .join('')
}

/**
 * Whether a timestamp describes something that has happened or something still
 * to come.
 *
 * A name-based guess, and it is a guess — but `measuredAt` in the future reads
 * as nonsense on screen, and JSON Schema has no way to say "in the past". The
 * cost of being wrong is a demo value somebody edits.
 */
function looksFuture(name: string): boolean {
  return /planned|expected|latest|until|due|earliest|scheduled|deadline|valid/i.test(name)
}

const HOUR = 60 * 60 * 1000

/** Human guidance for one field. What the author wrote wins over anything derived. */
export function hintFor(schema: JsonSchema): string | null {
  if (schema.description) return schema.description

  if (schema.pattern) {
    const segments = parsePattern(schema.pattern)
    // Never the raw regex: `^[A-Z]{4}[0-9]{7}$` in a placeholder is not guidance.
    if (segments) return describeSegments(segments)
    return null
  }
  if (schema.format === 'date-time') return 'Date and time'
  if (schema.format === 'uri') return 'A URI, for example urn:offering:…'
  if (schema.minimum !== undefined && schema.maximum !== undefined) {
    return `Between ${schema.minimum} and ${schema.maximum}`
  }
  if (schema.minimum !== undefined) return `${schema.minimum} or more`
  if (schema.maximum !== undefined) return `${schema.maximum} or less`
  return null
}

/**
 * What is wrong with this value, said before the connector says it.
 *
 * Empty is never a violation — that is the required check's business, and
 * shouting at somebody mid-keystroke is how a form becomes unpleasant.
 */
export function violationOf(value: unknown, schema: JsonSchema): string | null {
  if (value === undefined || value === null || value === '') return null

  if (schema.pattern && typeof value === 'string') {
    if (!new RegExp(schema.pattern).test(value)) {
      const segments = parsePattern(schema.pattern)
      return segments ? `Expected ${describeSegments(segments)}` : 'Not in the expected format'
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      return `Must be ${schema.minimum} or more`
    if (schema.maximum !== undefined && value > schema.maximum)
      return `Must be ${schema.maximum} or less`
  }
  if (schema.enum && !schema.enum.includes(value)) return 'Pick one of the offered values'
  return null
}

function typeOf(schema: JsonSchema): string {
  if (Array.isArray(schema.type)) return schema.type.find((one) => one !== 'null') ?? 'string'
  return schema.type ?? (schema.properties ? 'object' : 'string')
}

/** A plausible value for one field, or `undefined` where we cannot be sure. */
function sampleFor(name: string, schema: JsonSchema, now: Date, random: () => number): unknown {
  if (schema.default !== undefined) return schema.default
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[Math.floor(random() * schema.enum.length)]
  }

  const type = typeOf(schema)

  if (type === 'object' && schema.properties) {
    const nested = sampleObject(schema, now, random)
    return Object.keys(nested).length === 0 ? undefined : nested
  }

  if (type === 'number' || type === 'integer') {
    const min = schema.minimum ?? 1
    const max = schema.maximum ?? min + 1000
    const value = min + random() * (max - min)
    return type === 'integer' ? Math.round(value) : Math.round(value * 100) / 100
  }

  if (type === 'boolean') return random() > 0.5

  if (schema.pattern) {
    const segments = parsePattern(schema.pattern)
    // Unparseable: leave it. See `parsePattern`.
    return segments ? fromSegments(segments, random) : undefined
  }

  if (schema.format === 'date-time') {
    // A window either side of now, so a demo reads as something that is
    // actually happening today rather than in 1970.
    const offset = (1 + random() * 8) * HOUR
    return new Date(now.getTime() + (looksFuture(name) ? offset : -offset)).toISOString()
  }

  if (schema.format === 'uri') return `urn:demo:${name.toLowerCase()}:${Math.floor(random() * 1e6)}`

  if (type === 'string') {
    // Nothing constrains it, so the field's own name is the most useful thing
    // to put there — it reads as deliberate rather than as lorem ipsum.
    const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
    return `${words} ${Math.floor(random() * 9000 + 1000)}`
  }

  return undefined
}

/** Fill every property of an object schema that can be filled confidently. */
export function sampleObject(
  schema: JsonSchema,
  now: Date,
  random: () => number,
): Record<string, unknown> {
  const filled: Record<string, unknown> = {}
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const value = sampleFor(name, property, now, random)
    if (value !== undefined) filled[name] = value
  }
  return orderTimestamps(schema, filled)
}

/**
 * Put the timestamps of one object into the order they are declared in.
 *
 * Each field is generated independently, so a `{ earliest, latest }` pair comes
 * out in whatever order chance produced — and a pickup window that closes
 * before it opens is nonsense on screen and would fail a guard.
 *
 * The rule is the schema's own declaration order rather than a table of field
 * names: an author writes `earliest` before `latest`, and `from` before `to`,
 * because that is the order they mean. Sorting the *values* ascending and
 * reassigning them in declaration order keeps every generated instant while
 * making the pair read correctly. Only within one object, because two
 * timestamps in different objects are not a window.
 */
function orderTimestamps(
  schema: JsonSchema,
  filled: Record<string, unknown>,
): Record<string, unknown> {
  const names = Object.entries(schema.properties ?? {})
    .filter(([name, property]) => property.format === 'date-time' && name in filled)
    .map(([name]) => name)
  if (names.length < 2) return filled

  const ordered = names
    .map((name) => String(filled[name]))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
  for (const [index, name] of names.entries()) filled[name] = ordered[index]
  return filled
}
