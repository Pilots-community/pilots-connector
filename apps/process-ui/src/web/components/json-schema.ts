/**
 * The slice of JSON Schema this UI renders and reasons about.
 *
 * In its own module, and not beside the component, because the pure helpers
 * that use it (`sample-data.ts`) are unit-tested in vitest's `node` project —
 * which cannot parse a `.tsx` file. The same separation as `live/change-feed.ts`
 * and its browser binding: what is testable stays free of the environment.
 *
 * Deliberately partial. The connector validates against the real schema with
 * Ajv; this is only what a form needs in order to draw a field and say what is
 * expected of it.
 */
export interface JsonSchema {
  type?: string | string[]
  title?: string
  description?: string
  format?: string
  enum?: unknown[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  minimum?: number
  maximum?: number
  pattern?: string
  default?: unknown
}
