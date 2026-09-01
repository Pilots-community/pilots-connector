/**
 * The *other* validator.
 *
 * zod validates the protocol's own fixed shapes — event headers, instances,
 * connections, API keys. Ajv validates the JSON Schema a **definition supplies**
 * for its own `data`, `patch` and `guards`. Those are user documents; zod cannot
 * validate them, and unifying the two would mean either giving up user-supplied
 * schemas or reimplementing JSON Schema. Two validators, two jobs.
 *
 * Compiled schemas are cached by their canonical hash, because a definition's
 * schemas are recompiled on every single transition otherwise.
 */
import Ajv2020Module from 'ajv/dist/2020.js'
import type { ErrorObject, ValidateFunction } from 'ajv'
import addFormatsModule from 'ajv-formats'

import { hashJson } from '../canonical.js'
import type { JsonValue } from '../json.js'
import { protocolError, type ProblemType, type ProtocolError } from '../problems.js'

// ajv and ajv-formats are CommonJS; the interop shape differs between bundlers,
// so resolve the callable in one place rather than at every call site.
type Ajv2020Constructor = typeof Ajv2020Module
const Ajv2020: Ajv2020Constructor =
  typeof Ajv2020Module === 'function'
    ? Ajv2020Module
    : (Ajv2020Module as unknown as { default: Ajv2020Constructor }).default
type AddFormats = (ajv: unknown) => unknown
const addFormats: AddFormats =
  typeof addFormatsModule === 'function'
    ? (addFormatsModule as unknown as AddFormats)
    : (addFormatsModule as unknown as { default: AddFormats }).default

export interface SchemaValidator {
  /** Zero errors means valid. */
  validate(
    schema: Record<string, unknown>,
    value: JsonValue,
    problem: ProblemType,
    label?: string,
  ): ProtocolError[]
  /** Throws with a readable message if the schema itself is not valid JSON Schema. */
  assertValidSchema(schema: Record<string, unknown>): void
}

function describe(error: ErrorObject, label: string | undefined): ProtocolError['detail'] {
  const where = error.instancePath === '' ? 'the document' : error.instancePath
  const what = error.message ?? 'is invalid'
  return label ? `${label}: ${where} ${what}` : `${where} ${what}`
}

export function createSchemaValidator(): SchemaValidator {
  const ajv = new Ajv2020({
    // A definition's schemas come from another company. Refusing to run on an
    // unknown keyword would make us the strictest party in the room for no gain.
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
  })
  addFormats(ajv)

  const compiled = new Map<string, ValidateFunction>()

  function compile(schema: Record<string, unknown>): ValidateFunction {
    const key = hashJson(schema as JsonValue)
    let validate = compiled.get(key)
    if (!validate) {
      validate = ajv.compile(schema)
      compiled.set(key, validate)
    }
    return validate
  }

  return {
    validate(schema, value, problem, label) {
      const validate = compile(schema)
      if (validate(value)) return []
      return (validate.errors ?? []).map((error) =>
        protocolError(
          problem,
          describe(error, label),
          error.instancePath === '' ? undefined : error.instancePath,
        ),
      )
    },
    assertValidSchema(schema) {
      compile(schema)
    },
  }
}

let shared: SchemaValidator | undefined

/**
 * A process-wide validator, so the same definition's schemas compile once.
 * Callers that need isolation (a test asserting compilation behaviour) create
 * their own with `createSchemaValidator()`.
 */
export function defaultSchemaValidator(): SchemaValidator {
  shared ??= createSchemaValidator()
  return shared
}
