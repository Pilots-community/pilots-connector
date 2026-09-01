/**
 * The definition registry.
 *
 * Definitions are **content-addressed and versioned**: an instance pins
 * `id@version`, and a published definition never changes. Disagreement forks a
 * version instead of blocking anyone.
 *
 * The content hash is taken over the document **exactly as read**, not over the
 * parsed value. Parsing applies defaults — `defaultVisibility`, `auto`,
 * `cardinality` — and hashing after that would give two connectors holding the
 * same file two different hashes.
 *
 * A definition that fails the linter does not load. It is the artefact with the
 * least tolerance for a typo and the one nobody runs a debugger against.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  definitionRef,
  formatDiagnostic,
  hashJson,
  lintDefinition,
  type JsonValue,
  type LintDiagnostic,
  type ProcessDefinition,
} from '@pilots/protocol'

export interface RegisteredDefinition {
  /** `container-weighing@1.0.0` */
  ref: string
  definition: ProcessDefinition
  /** `sha256` of the canonicalised document as it was read from disk. */
  contentHash: string
  raw: JsonValue
  source: string
  /** Warnings the linter raised. They do not prevent loading; they are reported. */
  warnings: LintDiagnostic[]
}

export class DefinitionLoadError extends Error {
  constructor(
    readonly source: string,
    readonly diagnostics: LintDiagnostic[],
  ) {
    super(
      `${source} is not a loadable process definition:\n${diagnostics
        .map((d) => `  ${formatDiagnostic(d)}`)
        .join('\n')}`,
    )
    this.name = 'DefinitionLoadError'
  }
}

export class DefinitionRegistry {
  private readonly byRef = new Map<string, RegisteredDefinition>()

  private constructor(definitions: RegisteredDefinition[]) {
    for (const registered of definitions) this.byRef.set(registered.ref, registered)
  }

  static async fromDirectory(directory: string): Promise<DefinitionRegistry> {
    const files = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort()
    const loaded: RegisteredDefinition[] = []
    for (const file of files) {
      const source = join(directory, file)
      const raw = JSON.parse(await readFile(source, 'utf8')) as JsonValue
      loaded.push(DefinitionRegistry.register(raw, source))
    }
    return new DefinitionRegistry(loaded)
  }

  /** For tests and for a future admin-side upload. Lints before accepting. */
  static fromDocuments(documents: Array<{ raw: JsonValue; source: string }>): DefinitionRegistry {
    return new DefinitionRegistry(
      documents.map((d) => DefinitionRegistry.register(d.raw, d.source)),
    )
  }

  private static register(raw: JsonValue, source: string): RegisteredDefinition {
    const result = lintDefinition(raw)
    if (!result.ok || !result.definition) {
      throw new DefinitionLoadError(
        source,
        result.diagnostics.filter((d) => d.severity === 'error'),
      )
    }
    return {
      ref: definitionRef(result.definition),
      definition: result.definition,
      contentHash: hashJson(raw),
      raw,
      source,
      warnings: result.diagnostics.filter((d) => d.severity === 'warning'),
    }
  }

  get(ref: string): RegisteredDefinition | undefined {
    return this.byRef.get(ref)
  }

  /** Throws rather than returning undefined, for the many call sites that cannot proceed without it. */
  require(ref: string): RegisteredDefinition {
    const found = this.byRef.get(ref)
    if (!found) throw new Error(`unknown definition ${ref}`)
    return found
  }

  has(ref: string): boolean {
    return this.byRef.has(ref)
  }

  list(): RegisteredDefinition[] {
    return [...this.byRef.values()].sort((a, b) => a.ref.localeCompare(b.ref))
  }

  get size(): number {
    return this.byRef.size
  }
}

export const DEFINITION_REGISTRY = Symbol('DefinitionRegistry')
