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

/**
 * The token is stored across three global secrets and rejoined here.
 *
 * Reddit caps a `string` setting at 250 characters, and `isSecret` is only
 * available on `string` — `paragraph` takes longer values but cannot be marked
 * secret. A Clash of Clans JWT is around 570 characters, so splitting it is the
 * only way to keep it masked. Empty parts are skipped, so a shorter token that
 * fits in one or two still works.
 */
export const TOKEN_SETTINGS = [
  'cocApiToken1',
  'cocApiToken2',
  'cocApiToken3',
] as const

/** Every Clash of Clans JWT begins with this; used to catch a bad reassembly. */
const JWT_PREFIX = 'eyJ'

async function readToken(): Promise<
  {ok: true; token: string} | {ok: false; message: string}
> {
  const parts = await Promise.all(
    TOKEN_SETTINGS.map(async name => (await settings.get<string>(name)) ?? ''),
  )
  const token = parts.map(part => part.trim()).join('')

  if (token === '') {
    return {ok: false, message: `no token configured (${TOKEN_SETTINGS[0]}…)`}
  }
  if (!token.startsWith(JWT_PREFIX)) {
    // Almost always a part pasted out of order, or part 1 left unset.
    return {
      ok: false,
      message:
        'the assembled token is not a JWT — check the parts are in order ' +
        'and none is missing',
    }
  }
  return {ok: true, token}
}

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
  const token = await readToken()
  if (!token.ok) return {kind: 'unauthorized', message: token.message}

  const url = `${PROXY_BASE}/clans/${encodeURIComponent(clanTag)}`

  let rsp: Response
  try {
    rsp = await fetch(url, {
      headers: {Authorization: `Bearer ${token.token}`},
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
