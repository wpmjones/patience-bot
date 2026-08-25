import {redis} from '@devvit/web/server'
import type {Category} from '../shared/parse.ts'
import {barePostId, normalizeClanTag} from '../shared/parse.ts'

/**
 * Redis data layer for Patience Bot.
 *
 * The Postgres schema (post_id, tag, post_author, post_type, post_time,
 * processed) becomes sorted sets scored by post creation time in epoch
 * milliseconds, which answers both questions the bot actually asks: "when did X
 * last post" and "how many times has X posted inside the window".
 *
 * Keyspace:
 *   post:<id>                hash   metadata; TTL'd, so it self-cleans
 *   posts:tag:<clanTag>      zset   EVERY post for this clan, removed or not
 *   tracked:tag:<clanTag>    zset   only posts that count toward the cooldown
 *   tracked:author:<name>    zset   only posts that count toward the cooldown
 *   tags:active              zset   clan tags with recent activity
 *   authors:active           zset   authors with recent activity
 *   known:clans              zset   every clan ever seen — NEVER pruned
 *   known:authors            zset   every author ever seen — NEVER pruned
 *   weird:clans              hash   clans exempt from the name-in-title check
 *
 * Two things drove the shape:
 *
 * The split between `posts:` and `tracked:` replaces the old `processed`
 * boolean. A removed post must not start a new cooldown, but it must still
 * count toward the repeat-offender report — that report deliberately counts
 * removed posts, since posting ten times and being removed nine times is
 * exactly the behaviour it exists to surface.
 *
 * The `:active` indexes exist because Devvit's Redis has no keyspace scan. With
 * no way to enumerate `posts:tag:*`, pruning and the daily report would have
 * nothing to iterate, so we maintain the list ourselves.
 *
 * The `known:` sets are deliberately exempt from pruning. They answer "have we
 * ever seen this before", which drives the first-time welcome message. If they
 * expired on the seven-day cycle, anyone posting on an eight-day rhythm — legal
 * under a six-day cooldown — would be greeted as a newcomer every single time.
 */

export type PostRecord = {
  postId: string
  created: number
  category: Category
  clanTag?: string
  author?: string
  /** False for removed posts: recorded, but not starting a new cooldown. */
  tracked: boolean
}

/** Cooldown between posts for the same clan or author. */
export const COOLDOWN_MS = 6 * 24 * 60 * 60 * 1000

/** Anything older than this is pruned and never read. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

const RETENTION_SECONDS = Math.floor(RETENTION_MS / 1000)

export const KEY = {
  post: (postId: string): string => `post:${barePostId(postId)}`,
  postsByTag: (clanTag: string): string => `posts:tag:${clanTag}`,
  trackedByTag: (clanTag: string): string => `tracked:tag:${clanTag}`,
  trackedByAuthor: (author: string): string =>
    `tracked:author:${author.toLowerCase()}`,
  activeTags: 'tags:active',
  activeAuthors: 'authors:active',
  knownClans: 'known:clans',
  knownAuthors: 'known:authors',
  weirdClans: 'weird:clans',
} as const

/** Have we already processed this post? Guards against duplicate triggers. */
export async function hasSeenPost(postId: string): Promise<boolean> {
  // exists() returns a count of matching keys, not a boolean.
  return (await redis.exists(KEY.post(postId))) > 0
}

/**
 * Record a post.
 *
 * Untracked posts still land in `posts:tag:` and the post hash — they are
 * needed for spam counting and for duplicate suppression — but are kept out of
 * the `tracked:` sets so they cannot extend anyone's cooldown.
 */
export async function recordPost(record: PostRecord): Promise<void> {
  const id = barePostId(record.postId)
  const {created, tracked} = record

  const fields: Record<string, string> = {
    postId: id,
    created: String(created),
    category: record.category,
    tracked: tracked ? '1' : '0',
  }
  if (record.clanTag != null) fields.clanTag = record.clanTag
  if (record.author != null) fields.author = record.author

  await redis.hSet(KEY.post(id), fields)
  await redis.expire(KEY.post(id), RETENTION_SECONDS)

  if (record.clanTag != null) {
    await redis.zAdd(KEY.postsByTag(record.clanTag), {
      score: created,
      member: id,
    })
    await redis.zAdd(KEY.activeTags, {
      score: created,
      member: record.clanTag,
    })
    if (tracked) {
      await redis.zAdd(KEY.trackedByTag(record.clanTag), {
        score: created,
        member: id,
      })
    }
  }

  if (record.author != null && tracked) {
    await redis.zAdd(KEY.trackedByAuthor(record.author), {
      score: created,
      member: id,
    })
    await redis.zAdd(KEY.activeAuthors, {
      score: created,
      member: record.author.toLowerCase(),
    })
  }
}

export async function getPost(postId: string): Promise<PostRecord | undefined> {
  const hash = await redis.hGetAll(KEY.post(postId))
  if (hash.postId == null) return undefined
  return {
    postId: hash.postId,
    created: Number(hash.created ?? 0),
    category: (hash.category ?? '') as Category,
    clanTag: hash.clanTag,
    author: hash.author,
    tracked: hash.tracked === '1',
  }
}

type Entry = {postId: string; created: number}

/** Most recent cooldown-eligible post for a clan, or undefined if none. */
export async function lastTrackedPostForClan(
  clanTag: string,
): Promise<Entry | undefined> {
  return await newest(KEY.trackedByTag(clanTag))
}

/** Most recent cooldown-eligible post by an author, or undefined if none. */
export async function lastTrackedPostForAuthor(
  author: string,
): Promise<Entry | undefined> {
  return await newest(KEY.trackedByAuthor(author))
}

async function newest(key: string): Promise<Entry | undefined> {
  // by:'rank' with reverse puts the highest score at index 0.
  const rows = await redis.zRange(key, 0, 0, {by: 'rank', reverse: true})
  const row = rows[0]
  if (row == null) return undefined
  return {postId: row.member, created: row.score}
}

/**
 * Every post for a clan since `sinceMs`, removed posts included.
 *
 * Devvit's Redis has no zCount, so this returns the members and callers take
 * `.length`. The counts involved are small — a clan tripping the repeat-offender
 * threshold has posted ten times in six days.
 */
export async function postsForClanSince(
  clanTag: string,
  sinceMs: number,
): Promise<Entry[]> {
  const rows = await redis.zRange(KEY.postsByTag(clanTag), sinceMs, '+inf', {
    by: 'score',
  })
  return rows.map(row => ({postId: row.member, created: row.score}))
}

/** Clan tags with any activity since `sinceMs`. Drives the daily report. */
export async function activeClanTagsSince(sinceMs: number): Promise<string[]> {
  const rows = await redis.zRange(KEY.activeTags, sinceMs, '+inf', {
    by: 'score',
  })
  return rows.map(row => row.member)
}

/**
 * Distinct authors who posted for a clan since `sinceMs`.
 *
 * Reads the post hashes rather than keeping a parallel index, because this only
 * runs for clans that already tripped the report threshold, once a day.
 */
export async function authorsForClanSince(
  clanTag: string,
  sinceMs: number,
): Promise<string[]> {
  const entries = await postsForClanSince(clanTag, sinceMs)
  const authors = new Set<string>()
  for (const entry of entries) {
    const post = await getPost(entry.postId)
    if (post?.author != null) authors.add(post.author)
  }
  return [...authors]
}

export type Stats = {
  /** Clans ever seen. */
  knownClans: number
  /** Authors ever seen. */
  knownAuthors: number
  /** Clans that have posted inside the retention window. */
  activeClans: number
  /** Authors that have posted inside the retention window. */
  activeAuthors: number
  /** Clans exempt from the name-in-title check. */
  weirdClans: number
}

/** Counts for the moderator stats menu action. All O(1) except weirdClans. */
export async function getStats(): Promise<Stats> {
  return {
    knownClans: await redis.zCard(KEY.knownClans),
    knownAuthors: await redis.zCard(KEY.knownAuthors),
    activeClans: await redis.zCard(KEY.activeTags),
    activeAuthors: await redis.zCard(KEY.activeAuthors),
    weirdClans: (await redis.hKeys(KEY.weirdClans)).length,
  }
}

// "Have we ever seen this before" — permanent, never pruned.

/**
 * Record a clan as seen. Returns true only the first time it is ever called
 * for that clan, which is the signal for first-time handling.
 */
export async function markClanKnown(
  clanTag: string,
  nowMs: number,
): Promise<boolean> {
  return await markKnown(KEY.knownClans, clanTag, nowMs)
}

/**
 * Record an author as seen. Returns true only the first time it is ever called
 * for that author — the trigger for the welcome message.
 */
export async function markAuthorKnown(
  author: string,
  nowMs: number,
): Promise<boolean> {
  return await markKnown(KEY.knownAuthors, author.toLowerCase(), nowMs)
}

export async function isClanKnown(clanTag: string): Promise<boolean> {
  return (await redis.zScore(KEY.knownClans, clanTag)) != null
}

export async function isAuthorKnown(author: string): Promise<boolean> {
  return (await redis.zScore(KEY.knownAuthors, author.toLowerCase())) != null
}

/** Scores hold first-seen time, so an existing member is left untouched. */
async function markKnown(
  key: string,
  member: string,
  nowMs: number,
): Promise<boolean> {
  if ((await redis.zScore(key, member)) != null) return false
  await redis.zAdd(key, {score: nowMs, member})
  return true
}

// Weird clans — clans whose name legitimately does not appear in post titles.
// A hash, not a set, because Devvit's Redis exposes no set commands.

export type WeirdClan = {
  clanTag: string
  /** The clan's in-game name, for the moderator listing. */
  name?: string
  /** Why the name-in-title check can never pass for this clan. */
  reason?: string
}

/**
 * Exempt a clan from the name-in-title check.
 *
 * The name and reason are stored as JSON in the hash value. They are purely for
 * moderators reading the list later — "#2G2RPC8PC — emojis cause trouble" is
 * reviewable, a bare tag is not.
 *
 * The tag is normalised before use as the hash field. weird.json arrived with
 * at least one entry containing a letter O, which is not in Supercell's
 * alphabet; stored raw it could never match a tag parsed out of a post title,
 * so the exemption would silently do nothing.
 */
export async function addWeirdClan(
  clanTag: string,
  details: {name?: string; reason?: string} = {},
): Promise<void> {
  const key = normalizeClanTag(clanTag)
  await redis.hSet(KEY.weirdClans, {[key]: JSON.stringify(details)})
}

export async function removeWeirdClan(clanTag: string): Promise<void> {
  await redis.hDel(KEY.weirdClans, [normalizeClanTag(clanTag)])
}

export async function isWeirdClan(clanTag: string): Promise<boolean> {
  const raw = await redis.hGet(KEY.weirdClans, normalizeClanTag(clanTag))
  return raw != null
}

export async function getWeirdClan(
  clanTag: string,
): Promise<WeirdClan | undefined> {
  const key = normalizeClanTag(clanTag)
  const raw = await redis.hGet(KEY.weirdClans, key)
  if (raw == null) return undefined
  return {clanTag: key, ...parseWeird(raw)}
}

export async function listWeirdClans(): Promise<WeirdClan[]> {
  const all = await redis.hGetAll(KEY.weirdClans)
  return Object.entries(all)
    .map(([clanTag, raw]) => ({clanTag, ...parseWeird(raw)}))
    .sort((a, b) => a.clanTag.localeCompare(b.clanTag))
}

/** Tolerates entries written before details were stored. */
function parseWeird(raw: string): {name?: string; reason?: string} {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object') return {}
    return parsed as {name?: string; reason?: string}
  } catch {
    return {}
  }
}

/**
 * Drop everything older than the retention window.
 *
 * Post hashes expire on their own; this handles the sorted sets, which have no
 * per-member TTL. Emptied sorted sets are removed by Redis automatically, so
 * the keyspace does not accumulate dead keys.
 */
export async function pruneOlderThan(nowMs: number): Promise<number> {
  const cutoff = nowMs - RETENTION_MS
  let removed = 0

  for (const clanTag of await activeClanTagsSince(0)) {
    removed += await redis.zRemRangeByScore(KEY.postsByTag(clanTag), 0, cutoff)
    removed += await redis.zRemRangeByScore(
      KEY.trackedByTag(clanTag),
      0,
      cutoff,
    )
  }

  const authors = await redis.zRange(KEY.activeAuthors, 0, '+inf', {
    by: 'score',
  })
  for (const row of authors) {
    removed += await redis.zRemRangeByScore(
      KEY.trackedByAuthor(row.member),
      0,
      cutoff,
    )
  }

  // Prune the indexes last, so the loops above still saw every key.
  await redis.zRemRangeByScore(KEY.activeTags, 0, cutoff)
  await redis.zRemRangeByScore(KEY.activeAuthors, 0, cutoff)

  return removed
}

/**
 * Bulk import for the Postgres history, so the bot does not start cold and
 * treat every existing clan as new.
 */
export async function seedPosts(records: readonly PostRecord[]): Promise<void> {
  for (const record of records) await recordPost(record)
}
