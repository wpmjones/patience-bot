/** Generic error detail for all responses. */
export type ErrorRsp = {error: string; status: number}

export type Endpoint = (typeof Endpoint)[keyof typeof Endpoint]
export const Endpoint = {
  OnPostCreate: 'internal/on/post/create',
  OnModAction: 'internal/on/mod/action',
  OnMenuStats: 'internal/on/menu/stats',
  /** Post or subreddit menu: open the exempt-a-clan form. */
  OnMenuExemptClan: 'internal/on/menu/exempt-clan',
  OnFormExemptClan: 'internal/on/form/exempt-clan',
  /** Subreddit menu: review the exempt list and drop entries. */
  OnMenuWeirdClans: 'internal/on/menu/weird-clans',
  OnFormWeirdClans: 'internal/on/form/weird-clans',
  /** Temporary: remove along with src/server/seed/ after the cutover import. */
  OnMenuImportSeed: 'internal/on/menu/import-seed',
} as const

export const EndpointMethod = {
  [Endpoint.OnPostCreate]: 'POST',
  [Endpoint.OnModAction]: 'POST',
  [Endpoint.OnMenuStats]: 'POST',
  [Endpoint.OnMenuExemptClan]: 'POST',
  [Endpoint.OnFormExemptClan]: 'POST',
  [Endpoint.OnMenuWeirdClans]: 'POST',
  [Endpoint.OnFormWeirdClans]: 'POST',
  [Endpoint.OnMenuImportSeed]: 'POST',
} as const satisfies {[endpoint: string]: 'GET' | 'POST'}
