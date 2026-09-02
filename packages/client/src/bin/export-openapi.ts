#!/usr/bin/env node
/**
 * Write the OpenAPI document to disk.
 *
 *     pnpm --filter @pilots/client openapi:export
 *
 * The generated file is committed, and a test asserts it matches what this
 * script produces — so an API change that is not exported fails the build rather
 * than silently shipping a stale contract to whoever generated a client from it.
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { localApiDocument } from '../openapi.js'

const output = resolve(process.argv[2] ?? 'openapi.json')
writeFileSync(output, `${JSON.stringify(localApiDocument(), null, 2)}\n`, 'utf8')
process.stdout.write(`wrote ${output}\n`)
