/**
 * Accept raw bytes on the attachment upload route.
 *
 * Fastify parses `application/json` and rejects anything it has no parser for
 * with a `415`. A catch-all parser only runs for content-types nothing else
 * claimed, so JSON, problem+json and form bodies are untouched — this exists
 * solely so `POST /attachments` can receive a PDF as a PDF.
 *
 * The bytes are handed over unparsed. The connector hashes what it received, so
 * nothing here has to interpret the document, and a content type it has never
 * heard of is not a reason to refuse a document somebody signed a reference to.
 */
import type { FastifyInstance } from 'fastify'

export function acceptRawBodies(fastify: FastifyInstance): void {
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body)
  })
}
