/**
 * One place that names every piece of server state.
 *
 * Keys live here rather than at each call site so an invalidation cannot miss a
 * screen by spelling a key differently — which is the failure mode that makes
 * "why didn't it refresh?" so tedious to chase.
 *
 * Note what is *not* revalidated on a timer: the session and the definition
 * list. Neither changes while somebody watches, and refetching them every five
 * seconds would be noise on the wire and in the log.
 */
import { queryOptions } from '@tanstack/react-query'

import { api } from './api.js'

export const keys = {
  session: ['session'] as const,
  instances: ['instances'] as const,
  instance: (id: string) => ['instance', id] as const,
  events: (id: string) => ['events', id] as const,
  definitions: ['definitions'] as const,
  definition: (ref: string) => ['definition', ref] as const,
  offerings: ['offerings'] as const,
  connections: ['connections'] as const,
}

export const queries = {
  session: () => queryOptions({ queryKey: keys.session, queryFn: () => api.session() }),

  instances: () =>
    queryOptions({
      queryKey: keys.instances,
      queryFn: async () => (await api.instances()).instances,
    }),

  instance: (id: string) =>
    queryOptions({ queryKey: keys.instance(id), queryFn: () => api.instance(id) }),

  events: (id: string) =>
    queryOptions({ queryKey: keys.events(id), queryFn: () => api.events(id) }),

  definitions: () =>
    queryOptions({
      queryKey: keys.definitions,
      queryFn: async () => (await api.definitions()).definitions,
      // A definition is content-addressed and immutable at a given ref; the
      // list only changes when an operator loads one.
      staleTime: 5 * 60 * 1000,
    }),

  definition: (ref: string) =>
    queryOptions({
      queryKey: keys.definition(ref),
      queryFn: () => api.definition(ref),
      staleTime: 5 * 60 * 1000,
    }),

  offerings: () =>
    queryOptions({
      queryKey: keys.offerings,
      queryFn: async () => (await api.offerings()).offerings,
    }),

  connections: () =>
    queryOptions({
      queryKey: keys.connections,
      queryFn: async () => (await api.connections()).connections,
      staleTime: 60 * 1000,
    }),
}
