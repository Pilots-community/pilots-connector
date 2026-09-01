#!/usr/bin/env node
/**
 * Lint process definitions.
 *
 *     pnpm lint:definitions docs/definitions
 *     pnpm lint:definitions docs/definitions/container-weighing.json
 *
 * Exits non-zero if any definition has an error. Warnings are printed and do not
 * fail. Replaces tools/lint-definitions.py.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { formatDiagnostic, lintDefinition } from '../lint/linter.js'

function filesUnder(target: string): string[] {
  const path = resolve(target)
  if (statSync(path).isDirectory()) {
    return readdirSync(path)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => join(path, name))
  }
  return [path]
}

const targets = process.argv.slice(2)
if (targets.length === 0) {
  process.stderr.write('usage: pilots-lint-definitions <file-or-directory>...\n')
  process.exit(2)
}

let failed = false
let checked = 0

for (const file of targets.flatMap(filesUnder)) {
  checked += 1
  let result
  try {
    result = lintDefinition(JSON.parse(readFileSync(file, 'utf8')))
  } catch (cause) {
    process.stdout.write(
      `FAIL ${file}\n         - not readable JSON: ${(cause as Error).message}\n`,
    )
    failed = true
    continue
  }

  const errors = result.diagnostics.filter((d) => d.severity === 'error')
  const warnings = result.diagnostics.filter((d) => d.severity === 'warning')
  const summary = result.definition
    ? ` (${result.definition.roles.length} roles, ${result.definition.states.length} states, ${result.definition.transitions.length} transitions)`
    : ''

  process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'} ${file}${summary}\n`)
  for (const diagnostic of [...errors, ...warnings]) {
    process.stdout.write(`         - ${formatDiagnostic(diagnostic)}\n`)
  }
  if (!result.ok) failed = true
}

process.stdout.write(`\n${checked} definition(s) checked\n`)
process.exit(failed ? 1 : 0)
