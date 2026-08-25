/**
 * An in-memory stand-in for the subset of Devvit's Redis client that
 * src/server/db.ts uses.
 *
 * Devvit's real client only exists inside the Devvit runtime, so without this
 * the cooldown and pruning maths could only be checked by posting to a live
 * subreddit and waiting six days. Implemented against the signatures in
 * @devvit/redis/types/redis.d.ts.
 */

import type {redis} from '@devvit/web/server'

type ZEntry = {member: string; score: number}

type ZRangeOptions = {
  reverse?: boolean
  by: 'score' | 'lex' | 'rank'
  limit?: {offset: number; count: number}
}

/**
 * The slice of the real client this fake stands in for.
 *
 * The fake is checked against it with `satisfies`, so a signature that drifts
 * from Devvit's is a compile error here rather than a surprise at `tsc --build`
 * time — which is how the `exists()` return type (a count, not a boolean) got
 * through the first time.
 */
type SupportedRedis = Pick<
  typeof redis,
  | 'get'
  | 'set'
  | 'del'
  | 'exists'
  | 'expire'
  | 'hSet'
  | 'hGet'
  | 'hGetAll'
  | 'hKeys'
  | 'hDel'
  | 'zAdd'
  | 'zScore'
  | 'zCard'
  | 'zRange'
  | 'zRem'
  | 'zRemRangeByScore'
>

export type RedisFake = ReturnType<typeof createRedisFake>

export function createRedisFake() {
  const strings = new Map<string, string>()
  const hashes = new Map<string, Map<string, string>>()
  const zsets = new Map<string, Map<string, number>>()
  const expiries = new Map<string, number>()

  const sorted = (key: string): ZEntry[] =>
    [...(zsets.get(key) ?? new Map())]
      .map(([member, score]) => ({member, score}))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member))

  const bound = (value: number | string, fallback: number): number => {
    if (typeof value === 'number') return value
    if (value === '+inf') return Number.POSITIVE_INFINITY
    if (value === '-inf') return Number.NEGATIVE_INFINITY
    const parsed = Number(value)
    return Number.isNaN(parsed) ? fallback : parsed
  }

  const client = {
    async get(key: string): Promise<string | undefined> {
      return strings.get(key)
    },

    async set(key: string, value: string): Promise<string> {
      strings.set(key, value)
      return 'OK'
    },

    async del(...keys: string[]): Promise<void> {
      for (const key of keys) {
        strings.delete(key)
        hashes.delete(key)
        zsets.delete(key)
      }
    },

    async exists(...keys: string[]): Promise<number> {
      return keys.filter(
        key => strings.has(key) || hashes.has(key) || zsets.has(key),
      ).length
    },

    async expire(key: string, seconds: number): Promise<void> {
      expiries.set(key, seconds)
    },

    async hSet(
      key: string,
      fieldValues: Record<string, string>,
    ): Promise<number> {
      const hash = hashes.get(key) ?? new Map<string, string>()
      hashes.set(key, hash)
      let added = 0
      for (const [field, value] of Object.entries(fieldValues)) {
        if (!hash.has(field)) added++
        hash.set(field, value)
      }
      return added
    },

    async hGet(key: string, field: string): Promise<string | undefined> {
      return hashes.get(key)?.get(field)
    },

    async hGetAll(key: string): Promise<Record<string, string>> {
      return Object.fromEntries(hashes.get(key) ?? new Map())
    },

    async hKeys(key: string): Promise<string[]> {
      return [...(hashes.get(key)?.keys() ?? [])]
    },

    async hDel(key: string, fields: string[]): Promise<number> {
      const hash = hashes.get(key)
      if (!hash) return 0
      let removed = 0
      for (const field of fields) if (hash.delete(field)) removed++
      if (hash.size === 0) hashes.delete(key)
      return removed
    },

    async zAdd(key: string, ...members: ZEntry[]): Promise<number> {
      const zset = zsets.get(key) ?? new Map<string, number>()
      zsets.set(key, zset)
      let added = 0
      for (const {member, score} of members) {
        if (!zset.has(member)) added++
        zset.set(member, score)
      }
      return added
    },

    async zScore(key: string, member: string): Promise<number | undefined> {
      return zsets.get(key)?.get(member)
    },

    async zCard(key: string): Promise<number> {
      return zsets.get(key)?.size ?? 0
    },

    async zRange(
      key: string,
      start: number | string,
      stop: number | string,
      options?: ZRangeOptions,
    ): Promise<ZEntry[]> {
      let rows = sorted(key)

      if (options?.by === 'score') {
        const min = bound(start, Number.NEGATIVE_INFINITY)
        const max = bound(stop, Number.POSITIVE_INFINITY)
        rows = rows.filter(row => row.score >= min && row.score <= max)
        if (options.reverse) rows.reverse()
      } else {
        if (options?.reverse) rows.reverse()
        const from = bound(start, 0)
        const to = bound(stop, rows.length - 1)
        rows = rows.slice(from, to + 1)
      }

      if (options?.limit) {
        const {offset, count} = options.limit
        rows = rows.slice(offset, offset + count)
      }
      return rows
    },

    async zRem(key: string, members: string[]): Promise<number> {
      const zset = zsets.get(key)
      if (!zset) return 0
      let removed = 0
      for (const member of members) if (zset.delete(member)) removed++
      if (zset.size === 0) zsets.delete(key)
      return removed
    },

    async zRemRangeByScore(
      key: string,
      min: number,
      max: number,
    ): Promise<number> {
      const zset = zsets.get(key)
      if (!zset) return 0
      let removed = 0
      for (const [member, score] of [...zset]) {
        if (score >= min && score <= max) {
          zset.delete(member)
          removed++
        }
      }
      // Redis deletes a sorted set once its last member is gone.
      if (zset.size === 0) zsets.delete(key)
      return removed
    },
  } satisfies SupportedRedis

  /** `expiries` is test-only: the seconds passed to expire(), for assertions. */
  return {...client, expiries}
}
