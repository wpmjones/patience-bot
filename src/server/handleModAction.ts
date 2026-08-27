import {reddit} from '@devvit/web/server'
import type {T1} from '@devvit/web/shared'
import {getPost, setTracked, type TrackChange} from './db.ts'
import type {ModActionEvent} from './events.ts'

/**
 * Keeps the cooldown record in step with what the moderators actually decided.
 *
 * The bot's own removals are recorded as untracked, which is right while the
 * post is down. It stops being right the moment a moderator approves the post:
 * it is now publicly visible, so it has spent the clan's slot for the week, but
 * nothing in Redis says so. The clan posts again in two days and the bot waves
 * it through. Moderator removals are the same problem inverted — a post nobody
 * can see goes on holding a slot, and the author's corrected repost is refused
 * because of it.
 *
 * Both directions are one trigger. Reddit sends a ModAction for every action on
 * the subreddit, so the cheap checks come first and the expensive ones only run
 * for events that turn out to matter.
 */

/** Post actions that change whether a post is publicly visible. */
const REMOVING = ['removelink', 'spamlink']
const RESTORING = ['approvelink']

export type ModActionOptions = {
  /** Shadow mode: work out the correction and log it, but change nothing. */
  observeOnly: boolean
}

export async function handleModAction(
  event: ModActionEvent,
  options: ModActionOptions,
): Promise<string> {
  const action = event.action ?? ''
  const postId = event.targetPost?.id

  // Comment actions, flair edits, locks, bans — the overwhelming majority.
  if (postId == null) return `ignored: ${action || 'no action'} (not a post)`

  const restoring = RESTORING.includes(action)
  if (!restoring && !REMOVING.includes(action)) return `ignored: ${action}`

  const record = await getPost(postId)
  if (record == null) return `ignored: ${action} on an unrecorded post`
  if (record.tracked === restoring) return `no change: ${action}`

  // Only now is an API call worth making. A moderator acting through the app
  // account is the bot itself, and correcting our own bookkeeping would be a
  // loop. In practice this never fires — the bot's removals already agree with
  // the record — but the check is what guarantees that stays true.
  if (await isSelf(event.moderator?.name)) return `ignored: ${action} by self`

  const moderator = event.moderator?.name ?? 'unknown'
  if (options.observeOnly) {
    return `[observe] would ${restoring ? 'track' : 'untrack'} ${postId} after ${action} by u/${moderator}`
  }

  const change: TrackChange = await setTracked(postId, restoring)

  // The removal comment is only withdrawn on approval, and only the one the bot
  // left. A moderator removing a post has no bot comment to clean up.
  let withdrew = ''
  if (restoring && record.noticeCommentId != null) {
    withdrew = (await deleteComment(record.noticeCommentId))
      ? ', withdrew removal comment'
      : ', removal comment could not be withdrawn'
  }

  return `${restoring ? 'tracked' : 'untracked'} (${change}) after ${action} by u/${moderator}${withdrew}`
}

/**
 * Delete the bot's own comment.
 *
 * `delete`, not a moderator removal: this is the app withdrawing something it
 * said, and a removal would leave a `[removed]` stub under an approved post,
 * which is exactly the confusion being cleaned up.
 */
async function deleteComment(commentId: string): Promise<boolean> {
  try {
    const comment = await reddit.getCommentById(commentId as T1)
    await comment.delete()
    return true
  } catch (err) {
    // Already deleted by a moderator, or aged out. Not worth failing over.
    console.warn(
      `[modAction] could not delete ${commentId}; ${err instanceof Error ? err.message : err}`,
    )
    return false
  }
}

/** Memoised for the life of the instance; the app's own name cannot change. */
let appUsername: string | undefined | null = null

async function isSelf(moderator: string | undefined): Promise<boolean> {
  if (moderator == null) return false
  if (appUsername === null) {
    try {
      appUsername = (await reddit.getAppUser())?.username
    } catch {
      // Unknown means "not us", which errs toward correcting the record. A
      // wrongly-corrected record is recoverable; a silently stale one is the
      // bug this whole handler exists to fix.
      appUsername = undefined
    }
  }
  return appUsername != null && appUsername === moderator
}

/** Test seam: the memo would otherwise leak between cases. */
export function resetAppUserCache(): void {
  appUsername = null
}
