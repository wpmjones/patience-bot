import {redis, settings} from '@devvit/web/server'
import type {Category} from '../shared/parse.ts'

/**
 * Moderator notifications via a Discord incoming webhook.
 *
 * The Python bot passed an embed colour into notify_mods and rebuilt the
 * message by inspecting it — nextcord.Color.yellow() meant "posted too soon",
 * brand_red() meant "possible duplicate", and so on. Colour was carrying the
 * meaning, which is why one case (dark_orange, missing clan name) fell through
 * the ladder and rendered the generic "This post appears to be flawed".
 *
 * Here the event is a discriminated union and colour is derived from it.
 */

export const WEBHOOK_SETTING = 'discordWebhookUrl'

/** How long a given alert stays quiet after firing once. */
const ALERT_THROTTLE_MS = 30 * 60 * 1000

const COLOR = {
  removed: 0xe67e22,
  flagged: 0xf1c40f,
  alert: 0xe74c3c,
  report: 0x3498db,
} as const

export type PostRef = {
  /** Fullname or bare id; used only for display. */
  id: string
  title: string
  /** Absolute URL. */
  url: string
  author: string
  category?: Category
}

export type ClanRef = {tag: string; name?: string}

export type RemovalReason =
  | {code: 'cooldown'; previousUrl?: string; timeRemaining: string}
  | {code: 'missingCategory'}
  | {code: 'unknownCategory'; raw: string}
  | {code: 'badClanTag'; tried: readonly string[]}
  | {code: 'clanNameMismatch'; clanName: string}
  | {code: 'missingTownHall'}

export type FlagReason = {code: 'prohibitedTerms'; terms: readonly string[]}

export type ModEvent =
  | {
      kind: 'removed'
      post: PostRef
      clan?: ClanRef
      reason: RemovalReason
    }
  | {
      kind: 'flagged'
      post: PostRef
      clan?: ClanRef
      reason: FlagReason
    }
  | {
      kind: 'alert'
      /** Identity for throttling; the same key stays quiet for 30 minutes. */
      alertKey: string
      title: string
      detail: string
      post?: PostRef
    }
  | {
      kind: 'report'
      title: string
      description: string
      fields: readonly {name: string; value: string}[]
    }

type EmbedField = {name: string; value: string; inline?: boolean}

type Embed = {
  title: string
  description: string
  color: number
  fields: EmbedField[]
}

/**
 * Send a moderator notification.
 *
 * Returns false when nothing was sent — either the webhook is unconfigured or
 * an alert was throttled. Never throws: a Discord outage must not take down
 * post processing, so failures are logged and swallowed.
 */
export async function notifyMods(event: ModEvent): Promise<boolean> {
  const url = await settings.get<string>(WEBHOOK_SETTING)
  if (url == null || url === '') {
    console.warn(`[discord] ${WEBHOOK_SETTING} is not configured`)
    return false
  }

  if (event.kind === 'alert' && !(await claimAlert(event.alertKey))) {
    console.log(`[discord] alert "${event.alertKey}" throttled`)
    return false
  }

  const payload = buildPayload(event)

  try {
    const rsp = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    if (!rsp.ok) {
      console.error(`[discord] webhook returned HTTP ${rsp.status}`)
      return false
    }
    return true
  } catch (err) {
    console.error(
      `[discord] webhook failed; ${err instanceof Error ? err.message : err}`,
    )
    return false
  }
}

export function buildPayload(event: ModEvent): Record<string, unknown> {
  const embed = buildEmbed(event)

  return {
    // An alert is the only thing allowed to ping. Everything else parses no
    // mentions at all, because post titles are user-controlled and a clan
    // called "@everyone" must not be able to ping the mod channel.
    content:
      event.kind === 'alert'
        ? '@here Patience Bot needs attention — notify TubaKid via email.'
        : undefined,
    allowed_mentions: {parse: event.kind === 'alert' ? ['everyone'] : []},
    embeds: [embed],
  }
}

function buildEmbed(event: ModEvent): Embed {
  if (event.kind === 'report') {
    return {
      title: event.title,
      description: event.description,
      color: COLOR.report,
      fields: event.fields.map(field => ({...field, inline: true})),
    }
  }

  if (event.kind === 'alert') {
    return {
      title: event.title,
      description: event.detail,
      color: COLOR.alert,
      fields: event.post ? postFields(event.post) : [],
    }
  }

  const {description, extra} =
    event.kind === 'removed'
      ? describeRemoval(event.reason)
      : describeFlag(event.reason)

  return {
    title: event.kind === 'removed' ? 'Post removed' : 'Needs a look',
    description,
    color: event.kind === 'removed' ? COLOR.removed : COLOR.flagged,
    fields: [...extra, ...postFields(event.post), ...clanFields(event.clan)],
  }
}

function describeRemoval(reason: RemovalReason): {
  description: string
  extra: EmbedField[]
} {
  switch (reason.code) {
    case 'cooldown':
      return {
        description:
          'Posted again before the 6-day cooldown expired. Already removed, ' +
          'with a comment telling them when they may post again.',
        extra: [
          {
            name: 'May post again in',
            value: reason.timeRemaining,
            inline: true,
          },
          ...(reason.previousUrl == null
            ? []
            : [
                {
                  name: 'Previous post',
                  value: `[Link](${reason.previousUrl})`,
                  inline: true,
                },
              ]),
        ],
      }
    case 'missingCategory':
      return {
        description:
          'Title does not start with a category tag. Removed with the ' +
          'rule 6 formatting explanation.',
        extra: [],
      }
    case 'unknownCategory':
      return {
        description:
          `Title starts with \`[${reason.raw}]\`, which is not one of ` +
          '[Recruiting], [Searching] or [Merging]. Removed.',
        extra: [],
      }
    case 'badClanTag':
      return {
        description:
          'No clan tag in the title resolves to a real clan. Removed with ' +
          'the corrected-title instructions.',
        extra: [
          {
            name: 'Tags tried',
            value: reason.tried.length > 0 ? reason.tried.join(', ') : 'none',
            inline: true,
          },
        ],
      }
    case 'clanNameMismatch':
      return {
        description:
          `The title does not contain **${reason.clanName}**, the name of the ` +
          'clan its tag resolves to, and this clan is not on the exempt list. ' +
          '**Removed.** Usually a player tag used in place of a clan tag, or ' +
          'a name that is missing or mistyped.',
        extra: [
          {name: 'Expected clan name', value: reason.clanName, inline: true},
        ],
      }
    case 'missingTownHall':
      return {
        description:
          'Searching post with no Town Hall level in the title. Removed.',
        extra: [],
      }
    default:
      reason satisfies never
      return {description: 'Removed.', extra: []}
  }
}

function describeFlag(reason: FlagReason): {
  description: string
  extra: EmbedField[]
} {
  // Back to a single flag reason, so `satisfies never` cannot be used here —
  // it only narrows across a real union. Restore the guard if a second lands.
  switch (reason.code) {
    case 'prohibitedTerms':
      return {
        description:
          'This post mentions terms covered by the no-buying/selling/trading ' +
          'rule. **Not removed** — the words have innocent uses, so this ' +
          'needs a human read. Anything inside the clan name was ignored.',
        extra: [
          {
            name: 'Terms found',
            value: reason.terms.join(', '),
            inline: true,
          },
        ],
      }
  }
}

function postFields(post: PostRef): EmbedField[] {
  return [
    {name: 'Post', value: `[Link](${post.url})`, inline: true},
    {name: 'Author', value: `u/${post.author}`, inline: true},
    ...(post.category == null
      ? []
      : [{name: 'Category', value: post.category, inline: true}]),
    {name: 'Title', value: truncate(post.title, 1000), inline: false},
  ]
}

function clanFields(clan: ClanRef | undefined): EmbedField[] {
  if (clan == null) return []
  const stats = `https://www.clashofstats.com/clans/${clan.tag.replace(/^#/, '')}/summary`
  return [
    {name: 'Clan tag', value: clan.tag, inline: true},
    ...(clan.name == null
      ? []
      : [{name: 'Clan name', value: clan.name, inline: true}]),
    {name: 'Clash of Stats', value: `[Link](${stats})`, inline: true},
  ]
}

/**
 * True if this alert may fire now. Records the claim so repeats stay quiet.
 *
 * Without this a bad API token would produce one @here per post — around 58 a
 * day — which trains everyone to mute the channel precisely when the bot is
 * broken.
 */
async function claimAlert(alertKey: string): Promise<boolean> {
  const key = `alert:${alertKey}`
  if ((await redis.get(key)) != null) return false
  await redis.set(key, '1')
  await redis.expire(key, Math.floor(ALERT_THROTTLE_MS / 1000))
  return true
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
