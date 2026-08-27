import {reddit} from '@devvit/web/server'
import type {Category} from '../shared/parse.ts'

/**
 * Messages sent to the person who posted.
 *
 * Every removal produces two things: a distinguished comment on the post, and
 * a private message sent *as the subreddit*. The pairing is deliberate.
 *
 * The comment always lands — a private message does not, because users can
 * refuse messages from accounts they do not know, which the Python bot already
 * discovered and swallowed as "user probably doesn't allow DMs from unknown
 * sources".
 *
 * The message is sent as the subreddit rather than the app account so that
 * replying to it reaches modmail. The old bot told people to go find modmail
 * themselves, and instead received a steady stream of replies to an account
 * nobody reads. Now the reply path is the obvious one.
 */

const SUBREDDIT_URL = 'https://www.reddit.com/r/ClashOfClansRecruit'
const RULES_URL = `${SUBREDDIT_URL}/comments/4z3v3f/`

/** How the comment points people at the message they can actually reply to. */
const REPLY_HERE =
  "I've also sent you a private message from r/ClashOfClansRecruit — " +
  '**reply to that message** and it goes straight to the moderators. ' +
  'Replies to this comment are not monitored.'

const FORMAT_HELP = [
  'Your title must start with one of these tags, and follow the matching format:',
  '',
  '- `[Recruiting] Clan Name | #ClanTag | Required TH/Level | Clan Level | Play style | Clan system (or Independent)`',
  '- `[Searching] Town Hall Level | Overall Level | IGN | Min. Clan Level | Farming/Competitive`',
  '- `[Merging] Clan Name | #ClanTag | Number of members | Clan points/level`',
  '',
  `Full details are in the [sidebar rules](${RULES_URL}).`,
].join('\n')

export type AuthorNotice =
  | {kind: 'cooldown'; category: Category; timeRemaining: string}
  | {kind: 'tagTypo'; typed: string; actual: string; clanName: string}
  | {kind: 'missingCategory'}
  | {kind: 'unknownCategory'; raw: string}
  | {kind: 'badClanTag'}
  | {kind: 'clanNameMismatch'; clanName: string}
  | {kind: 'missingTownHall'}
  | {kind: 'welcome'}

export type NoticeText = {
  /** Markdown comment left on the post. Absent when nothing was removed. */
  comment?: string
  /** Subject of the private message. Absent when no message is sent. */
  subject?: string
  /** Markdown body of the private message. Absent when no message is sent. */
  message?: string
}

export function buildNotice(notice: AuthorNotice): NoticeText {
  switch (notice.kind) {
    case 'cooldown':
      return removal({
        subject: 'Your post was removed — please wait before posting again',
        why:
          `Your post has been removed because a ${notice.category} post for ` +
          'you or your clan already went up this week. One post a week keeps ' +
          'the queue fair for everyone.',
        fix: `**You may post again in ${notice.timeRemaining}.**`,
      })

    // Nothing was removed: normalisation repaired the tag and the clan was
    // found. The post is fine, but the tag printed in the title is wrong, so
    // this is a friendly correction rather than an enforcement action. No
    // private message — a comment is proportionate to a cosmetic fix.
    case 'tagTypo':
      return {
        comment: [
          'Hey Chief!',
          '',
          `Small heads up — your title lists \`${notice.typed}\`, but ` +
            `**${notice.clanName}**'s actual tag is \`${notice.actual}\`.`,
          '',
          'Clan tags only ever use the characters `0289PYLQGRJCUV`, so what ' +
            'looks like a letter O is always a zero. Your post is staying up ' +
            'and no action is needed — just worth knowing for next time, ' +
            'since a wrong tag makes your clan harder to find.',
          '',
          'Clash on!',
        ].join('\n'),
      }

    case 'missingCategory':
      return removal({
        subject: 'Your post was removed — title needs a category tag',
        why:
          'Your post has been removed because its title does not start with ' +
          'a category tag.',
        fix: FORMAT_HELP,
      })

    case 'unknownCategory':
      return removal({
        subject: 'Your post was removed — unrecognised category tag',
        why:
          `Your post has been removed because its title starts with ` +
          `\`[${notice.raw}]\`, which is not a category this subreddit uses.`,
        fix: FORMAT_HELP,
      })

    case 'badClanTag':
      return removal({
        subject: 'Your post was removed — clan tag not found',
        why:
          'Your post has been removed because the clan tag in your title ' +
          "doesn't match any clan the game knows about. Usually that means a " +
          'character was mistyped, dropped, or added by accident.',
        fix:
          'You can post again today with a corrected title. Copy the tag ' +
          'straight from the game — it sits under your clan name and starts ' +
          'with `#`. One thing worth knowing: clan tags only ever use the ' +
          'characters `0289PYLQGRJCUV`, so anything that looks like a letter ' +
          'O is really a zero.',
      })

    case 'clanNameMismatch':
      return removal({
        subject: "Your post was removed — clan name couldn't be confirmed",
        why:
          "Your post has been removed because we couldn't confirm that the " +
          'clan name in your title belongs to the clan tag you gave. The tag ' +
          `resolves to **${notice.clanName}**, which does not appear in your ` +
          'title.',
        fix:
          'This is most often one of three things: a **player** tag used ' +
          'where a **clan** tag belongs, a clan name left out of the title, ' +
          'or a clan name that is mistyped. Your clan name has to appear ' +
          'exactly as it does in game, including spacing and any special ' +
          'characters. You can post again today once the title is corrected.',
      })

    case 'missingTownHall':
      return removal({
        subject: 'Your post was removed — Town Hall level missing',
        why:
          'Your post has been removed because a `[Searching]` title has to ' +
          'include your Town Hall level, so clans can tell at a glance ' +
          'whether you are a fit.',
        fix: FORMAT_HELP,
      })

    case 'welcome':
      return {
        subject: 'Welcome to r/ClashOfClansRecruit!',
        message: [
          'Thanks for posting — this looks like your first time here, so a ' +
            'quick heads up on the one rule that catches people out.',
          '',
          'You can post **once a week**. Post sooner than that and this bot ' +
            'will remove it automatically.',
          '',
          `The [sidebar rules](${RULES_URL}) cover title formatting, which is ` +
            'the other common reason posts get removed.',
          '',
          'If you have questions, just reply to this message and the ' +
            'moderators will see it.',
          '',
          'Clash on!',
        ].join('\n'),
      }

    default:
      notice satisfies never
      throw new Error('unreachable')
  }
}

function removal(parts: {
  subject: string
  why: string
  fix: string
}): NoticeText {
  return {
    subject: parts.subject,
    comment: ['Hey Chief!', '', parts.why, '', parts.fix, '', REPLY_HERE].join(
      '\n',
    ),
    message: [
      'Hey Chief!',
      '',
      parts.why,
      '',
      parts.fix,
      '',
      'If you have questions, just reply to this message — it goes to the ' +
        'moderator team.',
      '',
      'Clash on!',
    ].join('\n'),
  }
}

/**
 * Deliver a notice.
 *
 * Comment and message are attempted independently: a user who refuses private
 * messages still gets the comment, and a failed comment does not suppress the
 * message. Neither failure propagates, because a post has already been removed
 * by this point and throwing would only lose the record of why.
 */
export async function sendNotice(
  notice: AuthorNotice,
  target: {postId: string; author: string; subredditName: string},
): Promise<{commented: boolean; messaged: boolean; commentId?: string}> {
  const text = buildNotice(notice)

  let commented = false
  let commentId: string | undefined
  if (text.comment != null) {
    try {
      const comment = await reddit.submitComment({
        id: target.postId as `t3_${string}`,
        text: text.comment,
      })
      await comment.distinguish(false)
      commented = true
      // Kept so the comment can be withdrawn if a moderator approves the post.
      commentId = comment.id
    } catch (err) {
      console.error(
        `[notice] comment failed on ${target.postId}; ${errText(err)}`,
      )
    }
  }

  let messaged = false
  if (text.message != null && text.subject != null) {
    try {
      await reddit.sendPrivateMessageAsSubreddit({
        fromSubredditName: target.subredditName,
        to: target.author,
        subject: text.subject,
        text: text.message,
      })
      messaged = true
    } catch (err) {
      // Most often the user does not accept messages from unknown senders.
      console.warn(
        `[notice] message failed to u/${target.author}; ${errText(err)}`,
      )
    }
  }

  return {commented, messaged, commentId}
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
