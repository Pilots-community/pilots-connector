/**
 * Who may read which field, as a field × role matrix.
 *
 * A role may read a path when *any* grant matches, so the matrix reads the
 * union, and a write replaces only that role's grants for that one path.
 */
import type { VisibilityDocument } from '../document.js'
import { readFields } from './fields.js'

export type Access = { kind: 'default' } | { kind: 'always' } | { kind: 'states'; states: string[] }

export function readAccess(visibility: VisibilityDocument[] | undefined, path: string, role: string): Access {
  const grants = (visibility ?? []).filter((grant) => grant.path === path && grant.roles.includes(role))
  if (grants.length === 0) return { kind: 'default' }
  if (grants.some((grant) => grant.whenState === undefined)) return { kind: 'always' }
  return { kind: 'states', states: [...new Set(grants.flatMap((grant) => grant.whenState ?? []))] }
}

export function writeAccess(
  visibility: VisibilityDocument[] | undefined,
  path: string,
  role: string,
  access: Access,
): VisibilityDocument[] {
  const next = (visibility ?? []).flatMap((grant) => {
    if (grant.path !== path || !grant.roles.includes(role)) return [structuredClone(grant)]
    const roles = grant.roles.filter((one) => one !== role)
    return roles.length === 0 ? [] : [{ ...structuredClone(grant), roles }]
  })
  if (access.kind === 'always') next.push({ path, roles: [role] })
  if (access.kind === 'states' && access.states.length > 0) {
    next.push({ path, roles: [role], whenState: [...access.states] })
  }
  return next
}

/** The rows of the matrix: every top-level field, plus any path a grant already names. */
export function visibilityPaths(data: unknown, visibility: VisibilityDocument[] | undefined): string[] {
  return [...new Set([...readFields(data).map((field) => field.name), ...(visibility ?? []).map((g) => g.path)])]
}
