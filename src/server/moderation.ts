import {reddit} from '@devvit/web/server'
import type {T3} from '@devvit/web/shared'

/**
 * Moderation actions taken on posts.
 *
 * Wrapped rather than called directly so every path has the same failure
 * behaviour: log and report back, never throw. A post that cannot be actioned
 * still needs its Discord notification to reach the moderators, and an
 * exception here would swallow that.
 */

/** Reddit truncates long report reasons; keep well inside the limit. */
const MAX_REPORT_REASON = 100

/**
 * Send a post to the mod queue without hiding it.
 *
 * Uses `report` rather than `filter`. Both put a post in the queue, but filter
 * can hide it pending review and is marked experimental in the API. For the
 * clan-name mismatch this is the wrong trade: it is the check most likely to
 * fire on a legitimate post — unusual fonts and stylised names read as
 * mismatches — and a hidden post burns the clan's one slot for the week while
 * it waits on a moderator. Reporting keeps it visible and still surfaces it.
 */
export async function reportPost(
  postId: string,
  reason: string,
): Promise<boolean> {
  try {
    const post = await reddit.getPostById(postId as T3)
    await reddit.report(post, {reason: truncate(reason, MAX_REPORT_REASON)})
    return true
  } catch (err) {
    console.error(`[mod] report failed on ${postId}; ${errText(err)}`)
    return false
  }
}

/**
 * Remove a post.
 *
 * Never marked as spam: these are rule violations, not spam, and a spam removal
 * feeds Reddit's automated signals against the author.
 */
export async function removePost(postId: string): Promise<boolean> {
  try {
    await reddit.remove(postId as T3, false)
    return true
  } catch (err) {
    console.error(`[mod] remove failed on ${postId}; ${errText(err)}`)
    return false
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
