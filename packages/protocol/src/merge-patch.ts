/**
 * JSON Merge Patch, RFC 7386.
 *
 * Hand-rolled on purpose. A transition's `patch` is a merge patch, so this
 * function *is* part of the specification — a dependency here would hide the
 * thing being defined. The algorithm is the one in RFC 7386 §2.
 */
import { cloneJson, isJsonObject } from './json.js'
import type { JsonObject, JsonValue } from './json.js'

/**
 * Apply `patch` to `target`, returning a new value. Neither argument is mutated
 * and the result shares no structure with either.
 *
 * A `null` in the patch deletes the key. A non-object patch replaces the target
 * outright — including an array, which merge patch never merges element-wise.
 */
export function applyMergePatch(target: JsonValue, patch: JsonValue): JsonValue {
  if (!isJsonObject(patch)) return cloneJson(patch)

  const result: JsonObject = isJsonObject(target) ? cloneJson(target) : {}

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key]
    } else if (value !== undefined) {
      result[key] = applyMergePatch(result[key] ?? null, value)
    }
  }

  return result
}
