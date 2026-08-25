/**
 * Trigger payload types, written from a real onPostCreate event rather than
 * from documentation. Only the fields the bot actually reads are declared;
 * Reddit sends considerably more.
 */

export type PostCreateEvent = {
  type: 'PostCreate'
  post: TriggerPost
  /** Absent when the author's account is deleted. */
  author?: TriggerAuthor
  subreddit?: TriggerSubreddit
}

export type TriggerPost = {
  /** Fullname including the `t3_` prefix, e.g. `t3_1vxm5ep`. */
  id: string
  title: string
  selftext: string
  /** Epoch MILLISECONDS. The Python bot's created_utc was seconds. */
  createdAt: number
  /** Fullname including the `t2_` prefix. */
  authorId: string
  /** Relative path, e.g. `/r/Sub/comments/…`, not an absolute URL. */
  url: string
  /** Relative path, same form as `url` for self posts. */
  permalink: string
  subredditId: string
  isSelf: boolean
  isApproved: boolean
  isLocked: boolean
  nsfw: boolean
  spam: boolean
  deleted: boolean
}

export type TriggerAuthor = {
  id: string
  name: string
  karma: number
  banned: boolean
  suspended: boolean
  spam: boolean
}

export type TriggerSubreddit = {
  id: string
  name: string
}
