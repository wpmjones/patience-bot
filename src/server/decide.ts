import {
  AUTHOR_CATEGORIES,
  CLAN_CATEGORIES,
  extractClanTagCandidates,
  extractTownHallLevel,
  formatTimeRemaining,
  parseCategory,
  titleContainsClanName,
  titleSpellsTagCorrectly,
} from '../shared/parse.ts'
import type {AuthorNotice} from './authorNotice.ts'
import type {Clan, ClanLookup, ClanResolution} from './coc.ts'
import {COOLDOWN_MS, type PostRecord} from './db.ts'
import type {FlagReason, RemovalReason} from './discord.ts'

/**
 * What should happen to a post — decided, not performed.
 *
 * Every rule lives here and nothing in this file touches Reddit, Redis, or the
 * network: dependencies arrive as functions. That keeps the rules exhaustively
 * testable, which matters because a mistake here removes real posts from real
 * people. The executor in handlePost.ts turns these effects into actions.
 */

export type PostFacts = {
  postId: string
  title: string
  /** Absent when the account is deleted. */
  author?: string
  createdAt: number
  /** Absolute URL. */
  url: string
  subredditName: string
}

export type Deps = {
  now: number
  hasSeenPost(postId: string): Promise<boolean>
  resolveClan(candidates: readonly string[]): Promise<ClanResolution>
  lastTrackedForClan(clanTag: string): Promise<TrackedPost | undefined>
  lastTrackedForAuthor(author: string): Promise<TrackedPost | undefined>
  isWeirdClan(clanTag: string): Promise<boolean>
  isAuthorKnown(author: string): Promise<boolean>
}

export type TrackedPost = {postId: string; created: number}

export type Effect =
  /** Remove the post, comment, and message the author. */
  | {kind: 'remove'; reason: RemovalReason; notice: AuthorNotice}
  /** Send to the mod queue without hiding it. */
  | {kind: 'report'; reason: string; flag: FlagReason; clan?: Clan}
  /** Comment (and maybe message) without any moderation action. */
  | {kind: 'notice'; notice: AuthorNotice}
  /** The bot is degraded; do nothing to the post. */
  | {kind: 'alert'; alertKey: string; title: string; detail: string}
  /** Write the post to Redis. */
  | {kind: 'record'; record: PostRecord}
  /** First sighting of this author or clan. */
  | {kind: 'markKnown'; author?: string; clanTag?: string}

export type Decision = {
  effects: Effect[]
  /** One line for the log, so live traffic is readable without a debugger. */
  summary: string
}

export async function decide(post: PostFacts, deps: Deps): Promise<Decision> {
  if (await deps.hasSeenPost(post.postId)) {
    return {effects: [], summary: 'already processed'}
  }

  const category = parseCategory(post.title)

  if (category.kind === 'missing') {
    return removeFor(post, {code: 'missingCategory'}, {kind: 'missingCategory'})
  }
  if (category.kind === 'unknown') {
    return removeFor(
      post,
      {code: 'unknownCategory', raw: category.raw},
      {kind: 'unknownCategory', raw: category.raw},
    )
  }

  if (CLAN_CATEGORIES.includes(category.category)) {
    return await decideClanPost(post, deps, category.category)
  }
  if (AUTHOR_CATEGORIES.includes(category.category)) {
    return await decideAuthorPost(post, deps, category.category)
  }

  // Unreachable while every category belongs to one of the two lists, but a
  // new category added to only one list should fail visibly rather than let
  // posts through unchecked.
  return {effects: [], summary: `category ${category.category} is unhandled`}
}

async function decideClanPost(
  post: PostFacts,
  deps: Deps,
  category: PostRecord['category'],
): Promise<Decision> {
  const candidates = extractClanTagCandidates(post.title)
  const resolution = await deps.resolveClan(candidates)

  if (resolution.kind === 'unresolved') {
    // The API is unreachable or misconfigured. Do nothing to the post and do
    // not record it, so the reconciliation job retries once we recover.
    return {
      effects: [
        {
          kind: 'alert',
          alertKey: `coc-${resolution.reason.kind}`,
          title: 'Clan lookups are failing',
          detail:
            `Clash of Clans lookups returned ${describeFailure(resolution.reason)}. ` +
            'Recruiting and Merging posts are NOT being checked or removed ' +
            'until this clears.',
        },
      ],
      summary: `clan lookup unresolved (${resolution.reason.kind}); post untouched`,
    }
  }

  if (resolution.kind === 'notFound') {
    return removeFor(
      post,
      {code: 'badClanTag', tried: resolution.tried},
      {kind: 'badClanTag'},
      category,
    )
  }

  const clan = resolution.clan
  const last = await deps.lastTrackedForClan(clan.tag)
  const cooldown = checkCooldown(last, post.createdAt, deps.now)

  if (cooldown != null) {
    return removeFor(
      post,
      {
        code: 'cooldown',
        timeRemaining: cooldown.timeRemaining,
        previousUrl: cooldown.previousUrl,
      },
      {kind: 'cooldown', category, timeRemaining: cooldown.timeRemaining},
      category,
      clan.tag,
    )
  }

  // The post is staying up. Everything below is advisory.
  const effects: Effect[] = [
    {
      kind: 'record',
      record: {
        postId: post.postId,
        created: post.createdAt,
        category,
        clanTag: clan.tag,
        author: post.author,
        tracked: true,
      },
    },
    {kind: 'markKnown', author: post.author, clanTag: clan.tag},
  ]
  const notes: string[] = []

  const nameMissing =
    !titleContainsClanName(clan.name, post.title) &&
    !(await deps.isWeirdClan(clan.tag))

  if (nameMissing) {
    effects.push({
      kind: 'report',
      reason: `Clan name "${clan.name}" not found in title`,
      flag: {code: 'missingClanName'},
      clan,
    })
    notes.push('clan name missing from title, reported')
  } else if (!titleSpellsTagCorrectly(post.title, clan.tag)) {
    // Only worth mentioning when the title is otherwise fine — a post already
    // in the mod queue does not need a pedantic note about a letter O.
    const typed = candidates[0] ?? clan.tag
    effects.push({
      kind: 'notice',
      notice: {
        kind: 'tagTypo',
        typed,
        actual: clan.tag,
        clanName: clan.name,
      },
    })
    notes.push('tag repaired, commented')
  }

  if (await isNewAuthor(post, deps)) {
    effects.push({kind: 'notice', notice: {kind: 'welcome'}})
    notes.push('welcomed')
  }

  return {
    effects,
    summary: `accepted ${category} for ${clan.tag}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`,
  }
}

async function decideAuthorPost(
  post: PostFacts,
  deps: Deps,
  category: PostRecord['category'],
): Promise<Decision> {
  if (extractTownHallLevel(post.title) == null) {
    return removeFor(
      post,
      {code: 'missingTownHall'},
      {kind: 'missingTownHall'},
      category,
    )
  }

  // Without an author there is nobody to rate limit and nobody to message.
  if (post.author == null) {
    return {
      effects: [
        {
          kind: 'record',
          record: {
            postId: post.postId,
            created: post.createdAt,
            category,
            tracked: false,
          },
        },
      ],
      summary: `${category} from a deleted account; recorded only`,
    }
  }

  const last = await deps.lastTrackedForAuthor(post.author)
  const cooldown = checkCooldown(last, post.createdAt, deps.now)

  if (cooldown != null) {
    return removeFor(
      post,
      {
        code: 'cooldown',
        timeRemaining: cooldown.timeRemaining,
        previousUrl: cooldown.previousUrl,
      },
      {kind: 'cooldown', category, timeRemaining: cooldown.timeRemaining},
      category,
    )
  }

  const effects: Effect[] = [
    {
      kind: 'record',
      record: {
        postId: post.postId,
        created: post.createdAt,
        category,
        author: post.author,
        tracked: true,
      },
    },
    {kind: 'markKnown', author: post.author},
  ]
  const notes: string[] = []

  if (await isNewAuthor(post, deps)) {
    effects.push({kind: 'notice', notice: {kind: 'welcome'}})
    notes.push('welcomed')
  }

  return {
    effects,
    summary: `accepted ${category} from u/${post.author}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`,
  }
}

/**
 * The welcome goes out only on a post that survives.
 *
 * A first-timer whose post is removed already receives a message explaining
 * exactly what went wrong; stacking "welcome, here are the rules" on top reads
 * as tone-deaf. They stay unknown, so they are welcomed on their first post
 * that actually lands.
 */
async function isNewAuthor(post: PostFacts, deps: Deps): Promise<boolean> {
  if (post.author == null) return false
  return !(await deps.isAuthorKnown(post.author))
}

function checkCooldown(
  last: TrackedPost | undefined,
  createdAt: number,
  now: number,
): {timeRemaining: string; previousUrl: string} | undefined {
  if (last == null) return undefined

  // Compare against the post's own timestamp, not the clock: a reconciliation
  // run hours later must judge the post as it stood when it was made.
  const elapsed = createdAt - last.created
  if (elapsed >= COOLDOWN_MS || elapsed < 0) return undefined

  return {
    timeRemaining: formatTimeRemaining(COOLDOWN_MS - (now - last.created)),
    previousUrl: `https://www.reddit.com/comments/${last.postId}`,
  }
}

function removeFor(
  post: PostFacts,
  reason: RemovalReason,
  notice: AuthorNotice,
  category?: PostRecord['category'],
  clanTag?: string,
): Decision {
  return {
    effects: [
      {kind: 'remove', reason, notice},
      {
        kind: 'record',
        record: {
          postId: post.postId,
          created: post.createdAt,
          // A removed post still needs a category for the record; the ones
          // removed before a category was parsed are recorded as Recruiting,
          // the overwhelming majority, purely so the row exists for dedup.
          category: category ?? 'Recruiting',
          clanTag,
          author: post.author,
          tracked: false,
        },
      },
    ],
    summary: `removed: ${reason.code}`,
  }
}

function describeFailure(reason: ClanLookup): string {
  switch (reason.kind) {
    case 'unauthorized':
      return `an authorisation error (${reason.message})`
    case 'rateLimited':
      return 'a rate limit'
    case 'error':
      return `an error (${reason.message})`
    default:
      // found / notFound never reach here — resolveClan only reports
      // `unresolved` for the failure kinds above.
      return 'an unexpected result'
  }
}
