import { describe, expect, it } from 'vitest'

import { formatDiagnostic, lintDefinition, type LintResult } from '../src/lint/linter.js'
import type { JsonValue } from '../src/json.js'
import { loadShippedDefinitions, shipped } from './helpers/definitions.js'

const shippedDefinitions = loadShippedDefinitions()

function errorCodes(result: LintResult): string[] {
  return result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)
}

function warningCodes(result: LintResult): string[] {
  return result.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.code)
}

/** A minimal, valid definition to break in one specific way per test. */
function baseline(): Record<string, JsonValue> {
  return {
    '@context': 'https://pilots.example/process/v1',
    id: 'baseline',
    version: '1.0.0',
    kind: 'service',
    title: 'Baseline',
    roles: [
      { id: 'requester', title: 'Requester' },
      { id: 'provider', title: 'Provider' },
    ],
    hostedBy: 'provider',
    initialState: 'OPEN',
    states: [
      { id: 'OPEN', title: 'Open' },
      { id: 'WORKING', title: 'Working' },
      { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
    ],
    data: { type: 'object', properties: { note: { type: 'string' } } },
    transitions: [
      { id: 'start', title: 'Start', from: ['OPEN'], to: 'WORKING', by: ['provider'] },
      { id: 'finish', title: 'Finish', from: ['WORKING'], to: 'DONE', by: ['provider'] },
      { id: 'ask', title: 'Ask', from: ['OPEN'], to: 'OPEN', by: ['requester'] },
    ],
  }
}

function lintWith(mutate: (d: Record<string, JsonValue>) => void): LintResult {
  const definition = baseline()
  mutate(definition)
  return lintDefinition(definition)
}

describe('M1 exit criterion: the five shipped definitions lint', () => {
  it.each(shippedDefinitions)('$name has no errors', ({ raw }) => {
    const result = lintDefinition(raw)
    if (!result.ok) throw new Error(result.diagnostics.map(formatDiagnostic).join('\n'))
    expect(result.ok).toBe(true)
  })

  it.each(shippedDefinitions)('$name has no warnings either', ({ raw }) => {
    const result = lintDefinition(raw)
    expect(result.diagnostics.map(formatDiagnostic)).toEqual([])
  })

  it('accepts the three-party definition under exactly the same schema', () => {
    const threeParty = shipped('container-transport-with-terminal.json')
    expect(threeParty.roles).toHaveLength(3)
    expect(lintDefinition(threeParty).ok).toBe(true)
  })
})

describe('the baseline is valid, so each failure below is the change under test', () => {
  it('lints clean', () => {
    expect(lintDefinition(baseline()).diagnostics).toEqual([])
  })
})

describe('structural errors', () => {
  it('rejects a definition that does not parse at all', () => {
    const result = lintDefinition({ id: 'broken' })
    expect(result.ok).toBe(false)
    expect(errorCodes(result).every((code) => code === 'schema')).toBe(true)
    expect(result.definition).toBeUndefined()
  })

  it('catches an unknown initialState', () => {
    expect(
      errorCodes(
        lintWith((d) => {
          d.initialState = 'NOWHERE'
        }),
      ),
    ).toContain('unknown-state')
  })

  /*
   * There is no longer an "unknown terminal state" to catch: terminality lives
   * on the state itself, so a terminal state that is not a declared state
   * cannot be expressed. What replaces it is the case that *can* still be
   * written — a process with no ending at all.
   */
  it('catches a definition in which no state declares an outcome', () => {
    expect(
      errorCodes(
        lintWith((d) => {
          for (const state of d['states'] as Array<Record<string, JsonValue>>) {
            delete state['outcome']
          }
        }),
      ),
    ).toContain('no-terminal-state')
  })

  it('catches hostedBy naming a role that does not exist', () => {
    expect(
      errorCodes(
        lintWith((d) => {
          d.hostedBy = 'nobody'
        }),
      ),
    ).toContain('unknown-role')
  })

  it('catches a duplicate transition id', () => {
    const result = lintWith((d) => {
      const transitions = d.transitions as Record<string, JsonValue>[]
      transitions.push({ ...transitions[0]! })
    })
    expect(errorCodes(result)).toContain('duplicate-id')
  })

  it('catches a duplicate state id', () => {
    const result = lintWith((d) => {
      ;(d.states as Record<string, JsonValue>[]).push({ id: 'OPEN', title: 'Open again' })
    })
    expect(errorCodes(result)).toContain('duplicate-id')
  })

  it('catches an unknown role in `by`', () => {
    const result = lintWith((d) => {
      ;(d.transitions as Record<string, JsonValue>[])[0]!.by = ['ghost']
    })
    expect(errorCodes(result)).toContain('unknown-role')
  })

  it('catches an unknown state in `from` and `to`', () => {
    expect(
      errorCodes(
        lintWith((d) => {
          ;(d.transitions as Record<string, JsonValue>[])[0]!.from = ['NOWHERE']
        }),
      ),
    ).toContain('unknown-state')
    expect(
      errorCodes(
        lintWith((d) => {
          ;(d.transitions as Record<string, JsonValue>[])[0]!.to = 'NOWHERE'
        }),
      ),
    ).toContain('unknown-state')
  })

  it('refuses the reserved transition id `create`', () => {
    const result = lintWith((d) => {
      ;(d.transitions as Record<string, JsonValue>[])[0]!.id = 'create'
    })
    expect(errorCodes(result)).toContain('reserved-id')
  })

  it('refuses an outgoing transition from a terminal state', () => {
    const result = lintWith((d) => {
      ;(d.transitions as Record<string, JsonValue>[]).push({
        id: 'undo',
        title: 'Undo',
        from: ['DONE'],
        to: 'OPEN',
        by: ['provider'],
      })
    })
    expect(errorCodes(result)).toContain('terminal-outgoing')
  })

  it('refuses a link that triggers a transition that does not exist', () => {
    const result = lintWith((d) => {
      d.links = [{ onEvent: 'quotation:AGREED', triggers: 'nonexistent' }]
    })
    expect(errorCodes(result)).toContain('dangling-reference')
  })

  it('refuses a visibility grant naming an unknown role or state', () => {
    expect(
      errorCodes(
        lintWith((d) => {
          d.visibility = [{ path: 'note', roles: ['ghost'] }]
        }),
      ),
    ).toContain('unknown-role')
    expect(
      errorCodes(
        lintWith((d) => {
          d.visibility = [{ path: 'note', roles: ['provider'], whenState: ['NOWHERE'] }]
        }),
      ),
    ).toContain('unknown-state')
  })

  it('refuses a data schema that is not valid JSON Schema', () => {
    const result = lintWith((d) => {
      d.data = { type: 'obejct' }
    })
    expect(errorCodes(result)).toContain('invalid-json-schema')
  })

  it('refuses a guard that is not valid JSON Schema', () => {
    const result = lintWith((d) => {
      ;(d.transitions as Record<string, JsonValue>[])[0]!.guards = [{ required: 'note' }]
    })
    expect(errorCodes(result)).toContain('invalid-json-schema')
  })
})

describe('reachability, in both directions', () => {
  it('catches a state nothing can reach', () => {
    const result = lintWith((d) => {
      ;(d.states as Record<string, JsonValue>[]).push({ id: 'ORPHAN', title: 'Orphan' })
      ;(d.transitions as Record<string, JsonValue>[]).push({
        id: 'escape',
        title: 'Escape',
        from: ['ORPHAN'],
        to: 'DONE',
        by: ['provider'],
      })
    })
    expect(errorCodes(result)).toContain('unreachable-state')
  })

  it('catches a state with no path to any terminal state', () => {
    const result = lintWith((d) => {
      ;(d.states as Record<string, JsonValue>[]).push({ id: 'TRAP', title: 'Trap' })
      ;(d.transitions as Record<string, JsonValue>[]).push({
        id: 'fall',
        title: 'Fall in',
        from: ['OPEN'],
        to: 'TRAP',
        by: ['provider'],
      })
    })
    expect(errorCodes(result)).toContain('dead-end-state')
  })
})

describe('deadlines', () => {
  const withDeadline = (transition: Record<string, JsonValue>) =>
    lintWith((d) => {
      const transitions = d.transitions as Record<string, JsonValue>[]
      transitions[0] = { ...transitions[0]!, ...transition }
    })

  it('accepts a deadline whose target applies in the state it arms in', () => {
    const result = lintWith((d) => {
      const transitions = d.transitions as Record<string, JsonValue>[]
      transitions[0] = { ...transitions[0]!, deadline: 'PT24H', onDeadline: 'abandon' }
      transitions.push({
        id: 'abandon',
        title: 'Abandon',
        from: ['WORKING'],
        to: 'DONE',
        by: [],
      })
    })
    expect(errorCodes(result)).toEqual([])
  })

  it('rejects a deadline with no onDeadline, and the reverse', () => {
    expect(errorCodes(withDeadline({ deadline: 'PT24H' }))).toContain('deadline')
    expect(errorCodes(withDeadline({ onDeadline: 'finish' }))).toContain('deadline')
  })

  it('rejects a deadline on a transition with no `to` to arm in', () => {
    const result = lintWith((d) => {
      const transitions = d.transitions as Record<string, JsonValue>[]
      transitions.push({
        id: 'note',
        title: 'Note',
        from: ['OPEN'],
        by: ['provider'],
        deadline: 'PT24H',
        onDeadline: 'finish',
      })
    })
    expect(errorCodes(result)).toContain('deadline')
  })

  it('rejects an onDeadline target that can never fire in the state the timer arms in', () => {
    // `start` leads to WORKING; `ask` only applies in OPEN, so it can never fire.
    expect(errorCodes(withDeadline({ deadline: 'PT24H', onDeadline: 'ask' }))).toContain('deadline')
  })

  it('rejects a deadline arming in a terminal state', () => {
    const result = lintWith((d) => {
      const transitions = d.transitions as Record<string, JsonValue>[]
      transitions[1] = { ...transitions[1]!, deadline: 'PT24H', onDeadline: 'finish' }
    })
    expect(errorCodes(result)).toContain('deadline')
  })

  it('rejects a duration outside the accepted subset at the schema level', () => {
    expect(errorCodes(withDeadline({ deadline: 'P1DT2H', onDeadline: 'finish' }))).toContain(
      'schema',
    )
  })
})

describe('warnings — worth saying, not worth refusing', () => {
  it('flags a role that may fire nothing', () => {
    const result = lintWith((d) => {
      ;(d.roles as Record<string, JsonValue>[]).push({ id: 'spectator', title: 'Spectator' })
    })
    expect(result.ok).toBe(true)
    expect(warningCodes(result)).toContain('unused-role')
  })

  it('accepts a declared observer without complaint', () => {
    const result = lintWith((d) => {
      ;(d.roles as Record<string, JsonValue>[]).push({
        id: 'spectator',
        title: 'Spectator',
        protocolRole: 'observer',
      })
    })
    expect(warningCodes(result)).not.toContain('unused-role')
  })

  it('flags a state id that is not UPPER_SNAKE_CASE', () => {
    const result = lintWith((d) => {
      d.states = [
        { id: 'open', title: 'Open' },
        { id: 'WORKING', title: 'Working' },
        { id: 'DONE', title: 'Done', outcome: 'fulfilled' },
      ]
      d.initialState = 'open'
      ;(d.transitions as Record<string, JsonValue>[])[0]!.from = ['open']
      ;(d.transitions as Record<string, JsonValue>[])[2]!.from = ['open']
      ;(d.transitions as Record<string, JsonValue>[])[2]!.to = 'open'
    })
    expect(result.ok).toBe(true)
    expect(warningCodes(result)).toContain('naming')
  })

  it('flags a visibility grant on a path the data schema never declares', () => {
    const result = lintWith((d) => {
      d.visibility = [{ path: 'phantom', roles: ['provider'] }]
    })
    expect(result.ok).toBe(true)
    expect(warningCodes(result)).toContain('visibility-path')
  })

  it('flags an unknown link relation, which would silently never fire', () => {
    const result = lintWith((d) => {
      d.links = [{ onEvent: 'invoice:PAID', triggers: 'finish' }]
    })
    expect(result.ok).toBe(true)
    expect(warningCodes(result)).toContain('unknown-relation')
  })

  it('flags defaultVisibility "none" with no grants at all', () => {
    const result = lintWith((d) => {
      d.defaultVisibility = 'none'
    })
    expect(result.ok).toBe(true)
    expect(warningCodes(result)).toContain('nothing-visible')
  })

  it('flags an auto transition that also lists roles', () => {
    const result = lintWith((d) => {
      ;(d.transitions as Record<string, JsonValue>[])[0]!.auto = true
    })
    expect(warningCodes(result)).toContain('auto-with-by')
  })
})
