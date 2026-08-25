import {settings} from '@devvit/web/server'

/**
 * Clash of Clans API client.
 *
 * Requests go through RoyaleAPI's proxy rather than api.clashofclans.com,
 * because Supercell binds API keys to fixed source IPs and Devvit apps run on
 * Reddit infrastructure with egress addresses we neither control nor know. The
 * proxy presents one static IP (45.79.218.79) which is allow-listed on the
 * Supercell developer portal instead. Paths and auth are otherwise identical.
 *
 * Only the read-only clan endpoint is used.
 */

const PROXY_BASE = 'https://cocproxy.royaleapi.dev/v1'

/** Devvit caps fetch at 30s; fail sooner so a trigger doesn't hang on one call. */
const TIMEOUT_MS = 10_000

/** Global secret in devvit.json. */
export const TOKEN_SETTING = 'cocApiToken'

export type Clan = {
  tag: string
  name: string
  level: number
  members: number
}

/**
 * The outcome of a lookup.
 *
 * `notFound` is the only result that may be treated as "this clan tag is bad",
 * and therefore the only one that can justify removing a post. Every other
 * outcome means we do not know — a misconfigured token or an un-allow-listed
 * proxy IP would otherwise remove every recruiting post on the subreddit.
 */
export type ClanLookup =
  | {kind: 'found'; clan: Clan}
  | {kind: 'notFound'}
  | {kind: 'unauthorized'; message: string}
  | {kind: 'rateLimited'}
  | {kind: 'error'; message: string}

export async function lookupClan(clanTag: string): Promise<ClanLookup> {
  const token = await settings.get<string>(TOKEN_SETTING)
  if (token == null || token === '') {
    return {kind: 'unauthorized', message: `${TOKEN_SETTING} is not configured`}
  }

  const url = `${PROXY_BASE}/clans/${encodeURIComponent(clanTag)}`

  let rsp: Response
  try {
    rsp = await fetch(url, {
      headers: {Authorization: `Bearer ${token}`},
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    return {
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  if (rsp.status === 404) return {kind: 'notFound'}
  if (rsp.status === 403 || rsp.status === 401) {
    // Almost always the proxy IP missing from the Supercell key's allow list.
    return {kind: 'unauthorized', message: `HTTP ${rsp.status}`}
  }
  if (rsp.status === 429) return {kind: 'rateLimited'}
  if (!rsp.ok) return {kind: 'error', message: `HTTP ${rsp.status}`}

  let body: unknown
  try {
    body = await rsp.json()
  } catch {
    return {kind: 'error', message: 'response was not JSON'}
  }

  const clan = toClan(body)
  if (clan == null) return {kind: 'error', message: 'unexpected response shape'}
  return {kind: 'found', clan}
}

export type ClanResolution =
  | {kind: 'found'; clan: Clan}
  /** Every candidate was checked and none exist. */
  | {kind: 'notFound'; tried: readonly string[]}
  /** Something went wrong; the caller must not treat this as a bad tag. */
  | {kind: 'unresolved'; reason: ClanLookup}

/**
 * Try each candidate tag in order and keep the first that resolves.
 *
 * Clan names can themselves contain tag-shaped text — "AK47#000" yields #000
 * ahead of the real tag — so the first regex match is not reliably the clan.
 * Letting the API arbitrate removes the need for per-clan special cases.
 *
 * Bails out immediately on any non-404 failure rather than continuing, because
 * a token or allow-list problem would otherwise look like "none of these tags
 * exist" and get a legitimate post removed.
 */
export async function resolveClan(
  candidates: readonly string[],
): Promise<ClanResolution> {
  if (candidates.length === 0) return {kind: 'notFound', tried: []}

  const tried: string[] = []
  for (const candidate of candidates) {
    tried.push(candidate)
    const result = await lookupClan(candidate)

    if (result.kind === 'found') return {kind: 'found', clan: result.clan}
    if (result.kind !== 'notFound') return {kind: 'unresolved', reason: result}
  }
  return {kind: 'notFound', tried}
}

function toClan(body: unknown): Clan | undefined {
  if (body == null || typeof body !== 'object') return undefined
  const raw = body as Record<string, unknown>
  if (typeof raw.tag !== 'string' || typeof raw.name !== 'string') {
    return undefined
  }
  return {
    tag: raw.tag,
    name: raw.name,
    level: typeof raw.clanLevel === 'number' ? raw.clanLevel : 0,
    members: typeof raw.members === 'number' ? raw.members : 0,
  }
}
