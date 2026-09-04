/**
 * Sample data, generated from the schema rather than from a table of fields.
 *
 * The claim this protects is the same one `SchemaForm` makes: **a new
 * definition needs no UI work.** A generator that knew what a container number
 * was would be a list to keep in step with every definition anybody writes, so
 * everything here is driven by `pattern`, `format`, `enum` and `minimum`.
 *
 * `now` and `random` are parameters, so the output is checkable rather than
 * merely plausible — the same reason `Clock` and `IdGenerator` are ports in the
 * connector.
 */
import { describe, expect, it } from 'vitest'

import type { JsonSchema } from '../src/web/components/json-schema.js'
import { hintFor, sampleObject, violationOf } from '../src/web/components/sample-data.js'

const NOW = new Date('2026-09-04T12:00:00.000Z')

describe('generating a value from a pattern', () => {
  const containerNumber: JsonSchema = { type: 'string', pattern: '^[A-Z]{4}[0-9]{7}$' }

  it('produces a string the pattern actually accepts', () => {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const made = sampleObject(
        { type: 'object', properties: { containerNumber } },
        NOW,
        Math.random,
      )
      expect(String(made['containerNumber'])).toMatch(/^[A-Z]{4}[0-9]{7}$/)
    }
  })

  it('is actually random, so two demos do not collide', () => {
    const values = new Set<string>()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const made = sampleObject(
        { type: 'object', properties: { containerNumber } },
        NOW,
        Math.random,
      )
      values.add(String(made['containerNumber']))
    }
    // Twenty draws from 26^4 × 10^7 should not collapse to one value.
    expect(values.size).toBeGreaterThan(15)
  })

  it('handles a three-letter code as well, without knowing it is a currency', () => {
    const made = sampleObject(
      { type: 'object', properties: { currency: { type: 'string', pattern: '^[A-Z]{3}$' } } },
      NOW,
      Math.random,
    )
    expect(String(made['currency'])).toMatch(/^[A-Z]{3}$/)
  })
})

describe('generating a time', () => {
  const at = (name: string): Date => {
    const made = sampleObject(
      { type: 'object', properties: { [name]: { type: 'string', format: 'date-time' } } },
      NOW,
      Math.random,
    )
    return new Date(String(made[name]))
  }

  it('puts something already recorded in the recent past', () => {
    // `measuredAt` describes a weighing that has happened. A timestamp in the
    // future would be nonsense on screen and would fail a guard elsewhere.
    for (const name of ['measuredAt', 'actualPickupAt', 'deliveredAt', 'issuedAt']) {
      expect(at(name).getTime(), name).toBeLessThanOrEqual(NOW.getTime())
      expect(at(name).getTime(), name).toBeGreaterThan(NOW.getTime() - 24 * 60 * 60 * 1000)
    }
  })

  it('puts something still to happen in the near future', () => {
    for (const name of ['plannedPickupAt', 'expectedAt', 'validUntil', 'latest']) {
      expect(at(name).getTime(), name).toBeGreaterThan(NOW.getTime())
    }
  })

  it('emits the protocol’s timestamp format, not the widget’s', () => {
    const made = sampleObject(
      { type: 'object', properties: { measuredAt: { type: 'string', format: 'date-time' } } },
      NOW,
      Math.random,
    )
    expect(String(made['measuredAt'])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

describe('generating from the other constraints', () => {
  it('picks a member of an enum', () => {
    const made = sampleObject(
      {
        type: 'object',
        properties: { containerType: { type: 'string', enum: ['20DV', '40DV', '40HC'] } },
      },
      NOW,
      Math.random,
    )
    expect(['20DV', '40DV', '40HC']).toContain(made['containerType'])
  })

  it('respects a minimum', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const made = sampleObject(
        { type: 'object', properties: { value: { type: 'number', minimum: 10 } } },
        NOW,
        Math.random,
      )
      expect(Number(made['value'])).toBeGreaterThanOrEqual(10)
    }
  })

  it('fills a nested object, because a price is one', () => {
    const made = sampleObject(
      {
        type: 'object',
        properties: {
          price: {
            type: 'object',
            properties: {
              value: { type: 'number', minimum: 0 },
              currency: { type: 'string', pattern: '^[A-Z]{3}$' },
            },
          },
        },
      },
      NOW,
      Math.random,
    )
    const price = made['price'] as Record<string, unknown>
    expect(typeof price['value']).toBe('number')
    expect(String(price['currency'])).toMatch(/^[A-Z]{3}$/)
  })

  it('leaves a field it cannot satisfy alone rather than inventing rubbish', () => {
    // A pattern the tiny expander does not understand. Filling it with a
    // plausible-looking string that the connector then refuses would be worse
    // than leaving it for a person.
    const made = sampleObject(
      { type: 'object', properties: { weird: { type: 'string', pattern: '^(?=.*x)[a-z]+$' } } },
      NOW,
      Math.random,
    )
    expect(made['weird']).toBeUndefined()
  })
})

describe('the guidance a person reads', () => {
  it('turns a pattern into words and an example, never a raw regex', () => {
    const hint = hintFor({ type: 'string', pattern: '^[A-Z]{4}[0-9]{7}$' })
    expect(hint).toContain('4 letters')
    expect(hint).toContain('7 digits')
    expect(hint).not.toContain('^')
    expect(hint).not.toContain('[A-Z]')
  })

  it('describes a minimum and a date', () => {
    expect(hintFor({ type: 'number', minimum: 0 })).toContain('0 or more')
    expect(hintFor({ type: 'string', format: 'date-time' })).toContain('Date and time')
  })

  it('prefers what the definition author wrote', () => {
    // A description is a human sentence; a derived hint is a fallback for when
    // nobody wrote one.
    expect(hintFor({ type: 'string', pattern: '^[A-Z]{3}$', description: 'ISO 4217 code' })).toBe(
      'ISO 4217 code',
    )
  })
})

describe('saying what is wrong, before the connector does', () => {
  it('reports a value that does not match its pattern', () => {
    expect(violationOf('abc', { type: 'string', pattern: '^[A-Z]{4}[0-9]{7}$' })).toContain(
      '4 letters',
    )
  })

  it('reports a number below its minimum', () => {
    expect(violationOf(-5, { type: 'number', minimum: 0 })).toContain('0 or more')
  })

  it('is silent on a value that is fine, and on an empty one', () => {
    expect(violationOf('MSCU1234567', { type: 'string', pattern: '^[A-Z]{4}[0-9]{7}$' })).toBeNull()
    // Empty is "not filled in yet", which is the required check's business and
    // not something to shout about while somebody is still typing.
    expect(violationOf('', { type: 'string', pattern: '^[A-Z]{4}[0-9]{7}$' })).toBeNull()
    expect(violationOf(undefined, { type: 'number', minimum: 0 })).toBeNull()
  })
})

describe('a pair of timestamps is a window, not two draws', () => {
  const window: JsonSchema = {
    type: 'object',
    properties: {
      earliest: { type: 'string', format: 'date-time' },
      latest: { type: 'string', format: 'date-time' },
    },
  }

  it('never closes a window before it opens', () => {
    // Each field is generated independently, so without ordering this fails
    // roughly half the time — and a pickup window that ends before it starts
    // is nonsense on screen and would fail a guard.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const made = sampleObject(window, NOW, Math.random)
      expect(Date.parse(String(made['latest']))).toBeGreaterThanOrEqual(
        Date.parse(String(made['earliest'])),
      )
    }
  })

  it('orders by the schema’s declaration order, not by field name', () => {
    // `from` before `to` is the author saying which comes first. No table of
    // known names is involved.
    const trip: JsonSchema = {
      type: 'object',
      properties: {
        from: { type: 'string', format: 'date-time' },
        to: { type: 'string', format: 'date-time' },
      },
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const made = sampleObject(trip, NOW, Math.random)
      expect(Date.parse(String(made['to']))).toBeGreaterThanOrEqual(
        Date.parse(String(made['from'])),
      )
    }
  })

  it('leaves a lone timestamp alone', () => {
    const made = sampleObject(
      { type: 'object', properties: { measuredAt: { type: 'string', format: 'date-time' } } },
      NOW,
      Math.random,
    )
    expect(Date.parse(String(made['measuredAt']))).toBeLessThanOrEqual(NOW.getTime())
  })
})
