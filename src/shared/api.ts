/** Generic error detail for all responses. */
export type ErrorRsp = {error: string; status: number}

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint]
export const Endpoint = {
  OnPostCreate: 'internal/on/post/create',
  OnMenuStats: 'internal/on/menu/stats',
  /** Temporary: remove along with src/server/seed/ after the cutover import. */
  OnMenuImportSeed: 'internal/on/menu/import-seed',
} as const

export const EndpointMethod = {
  [Endpoint.OnPostCreate]: 'POST',
  [Endpoint.OnMenuStats]: 'POST',
  [Endpoint.OnMenuImportSeed]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
