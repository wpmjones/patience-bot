import {absoluteUrl} from '../shared/parse.ts'
import {sendNotice} from './authorNotice.ts'
import {resolveClan} from './coc.ts'
import {
  hasSeenPost,
  isAuthorKnown,
  isWeirdClan,
  lastTrackedPostForAuthor,
  lastTrackedPostForClan,
  markAuthorKnown,
  markClanKnown,
  recordPost,
} from './db.ts'
import {decide, type Effect, type PostFacts} from './decide.ts'
import {notifyMods, type PostRef} from './discord.ts'
import type {PostCreateEvent} from './events.ts'
import {removePost, reportPost} from './moderation.ts'

/**
 * Turns a decision into actions.
 *
 * Split from decide.ts so the rules can be tested without mocking Reddit,
 * Redis, Discord and the game API at once. This half is deliberately dull: it
 * walks the effect list and performs each one.
 *
 * `observeOnly` runs everything except the actions that change the subreddit —
 * removals, reports, comments and messages. Redis still records, Discord still
 * reports what *would* have happened. That is the shadow run: real traffic,
 * real decisions, no consequences.
 */

export type HandleOptions = {
  observeOnly: boolean
  now: number
}

export async function handlePostCreate(
  event: PostCreateEvent,
  options: HandleOptions,
): Promise<string> {
  const post: PostFacts = {
    postId: event.post.id,
    title: event.post.title,
    author: event.author?.name,
    createdAt: event.post.createdAt,
    url: absoluteUrl(event.post.permalink),
    subredditName: event.subreddit?.name ?? '',
  }

  const decision = await decide(post, {
    now: options.now,
    hasSeenPost,
    resolveClan,
    lastTrackedForClan: lastTrackedPostForClan,
    lastTrackedForAuthor: lastTrackedPostForAuthor,
    isWeirdClan,
    isAuthorKnown,
  })

  for (const effect of decision.effects) {
    await apply(effect, post, options)
  }

  const prefix = options.observeOnly ? '[observe] ' : ''
  return `${prefix}${decision.summary}`
}

async function apply(
  effect: Effect,
  post: PostFacts,
  options: HandleOptions,
): Promise<void> {
  const ref: PostRef = {
    id: post.postId,
    title: post.title,
    url: post.url,
    author: post.author ?? '[deleted]',
  }
  const target = {
    postId: post.postId,
    author: post.author ?? '',
    subredditName: post.subredditName,
  }

  switch (effect.kind) {
    case 'remove': {
      if (!options.observeOnly) {
        await removePost(post.postId)
        if (post.author != null) await sendNotice(effect.notice, target)
      }
      await notifyMods({kind: 'removed', post: ref, reason: effect.reason})
      return
    }

    case 'report': {
      if (!options.observeOnly) await reportPost(post.postId, effect.reason)
      await notifyMods({
        kind: 'flagged',
        post: ref,
        clan:
          effect.clan == null
            ? undefined
            : {tag: effect.clan.tag, name: effect.clan.name},
        reason: effect.flag,
      })
      return
    }

    case 'notice': {
      if (!options.observeOnly && post.author != null) {
        await sendNotice(effect.notice, target)
      }
      return
    }

    case 'alert': {
      // Alerts fire in observe mode too — a broken API is worth knowing about
      // whether or not the bot is armed.
      await notifyMods({
        kind: 'alert',
        alertKey: effect.alertKey,
        title: effect.title,
        detail: effect.detail,
        post: ref,
      })
      return
    }

    case 'record':
      await recordPost(effect.record)
      return

    case 'markKnown': {
      if (effect.author != null)
        await markAuthorKnown(effect.author, options.now)
      if (effect.clanTag != null)
        await markClanKnown(effect.clanTag, options.now)
      return
    }

    default:
      effect satisfies never
  }
}
