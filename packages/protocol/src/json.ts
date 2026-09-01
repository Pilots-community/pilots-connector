/**
 * The JSON value model every artefact in this protocol is expressed in.
 *
 * Instance data documents, event payloads and merge patches are all JSON and
 * nothing else. Keeping that explicit here means the rest of the package never
 * has to reach for `any`.
 */

export type JsonPrimitive = string | number | boolean | null

export type JsonValue = JsonPrimitive | JsonArray | JsonObject

// The empty body is what makes this recursive without a circular type alias.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface JsonArray extends Array<JsonValue> {}

export interface JsonObject {
  [key: string]: JsonValue
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isJsonArray(value: unknown): value is JsonArray {
  return Array.isArray(value)
}

/** A structural deep clone, so callers never share mutable substructure. */
export function cloneJson<T extends JsonValue | undefined>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value
  return structuredClone(value)
}
