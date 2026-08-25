import {redis} from '@devvit/web/server'
import type {Category} from '../../shared/parse.ts'
import {Category as Categories} from '../../shared/parse.ts'
import {addWeirdClan, KEY, recordPost} from '../db.ts'
import type {SeedPost, SeedWeirdClan} from './seedData.ts'

/**
 * One-time import of the Python bot's history.
 *
 * Chunked and resumable rather than one long pass: seeding 562 posts is roughly
 * 3,400 sequential Redis round trips, and Devvit's per-request time budget is
 * not documented anywhere I could find. Progress cursors live in Redis, so
 * running this repeatedly is safe and simply continues where it stopped.
 *
 * Delete this directory once the import has run against the live subreddit.
 */

/** Posts handled per invocation. Small enough to finish well inside any budget. */
const POST_CHUNK = 100

/** Members per zAdd. Keeps individual request payloads reasonable. */
const ZADD_CHUNK = 500

const CURSOR = {
  authors: 'seed:authors:done',
  clans: 'seed:clans:done',
  weird: 'seed:weird:done',
  posts: 'seed:posts:cursor',
} as const

export type SeedData = {
  authors: readonly string[]
  clans: readonly string[]
  weird: readonly SeedWeirdClan[]
  posts: readonly SeedPost[]
}

export type SeedProgress = {
  authorsImported: number
  clansImported: number
  weirdImported: number
  postsImported: number
  totalPosts: number
  done: boolean
}

/**
 * Import one chunk of seed data. Call until `done` is true.
 *
 * Known authors and clans are written with a score of 0, meaning "known before
 * we started recording first-seen times" — the score is never read, only
 * membership is.
 */
export async function runSeed(data: SeedData): Promise<SeedProgress> {
  const authorsImported = await seedKnown(
    CURSOR.authors,
    KEY.knownAuthors,
    data.authors.map(author => author.toLowerCase()),
  )
  const clansImported = await seedKnown(
    CURSOR.clans,
    KEY.knownClans,
    data.clans,
  )
  const weirdImported = await seedWeird(data.weird)

  const cursor = Number((await redis.get(CURSOR.posts)) ?? 0)
  const slice = data.posts.slice(cursor, cursor + POST_CHUNK)

  for (const post of slice) {
    const category = toCategory(post.c)
    if (category == null) continue // Unknown category; nothing sensible to store.
    await recordPost({
      postId: post.i,
      created: post.t,
      category,
      clanTag: post.g ?? undefined,
      author: post.a,
      tracked: post.k === 1,
    })
  }

  const next = cursor + slice.length
  await redis.set(CURSOR.posts, String(next))

  return {
    authorsImported,
    clansImported,
    weirdImported,
    postsImported: next,
    totalPosts: data.posts.length,
    done: next >= data.posts.length,
  }
}

/**
 * Import the weird-clan exemptions. Guarded separately from the other sections
 * so it still runs on a store where the earlier ones already completed.
 */
async function seedWeird(entries: readonly SeedWeirdClan[]): Promise<number> {
  if ((await redis.get(CURSOR.weird)) != null) return 0

  for (const entry of entries) {
    await addWeirdClan(entry.clanTag, {
      name: entry.name,
      reason: entry.reason,
    })
  }

  await redis.set(CURSOR.weird, '1')
  return entries.length
}

/**
 * Bulk-load a known set once, guarded by a flag so repeat calls are cheap.
 * Returns how many members were written this call — 0 once already done.
 */
async function seedKnown(
  flagKey: string,
  setKey: string,
  members: readonly string[],
): Promise<number> {
  if ((await redis.get(flagKey)) != null) return 0

  for (let i = 0; i < members.length; i += ZADD_CHUNK) {
    const chunk = members
      .slice(i, i + ZADD_CHUNK)
      .map(member => ({score: 0, member}))
    if (chunk.length > 0) await redis.zAdd(setKey, ...chunk)
  }

  await redis.set(flagKey, '1')
  return members.length
}

function toCategory(raw: string): Category | undefined {
  const match = Object.values(Categories).find(value => value === raw)
  return match as Category | undefined
}

/** Clears the cursors so the import can be re-run from scratch. */
export async function resetSeed(): Promise<void> {
  await redis.del(CURSOR.authors, CURSOR.clans, CURSOR.weird, CURSOR.posts)
}
