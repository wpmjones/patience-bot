import type {Form, UiResponse} from '@devvit/web/shared'
import {extractClanTagCandidates, normalizeClanTag} from '../shared/parse.ts'
import type {ClanResolution} from './coc.ts'
import {addWeirdClan, listWeirdClans, removeWeirdClan} from './db.ts'

/**
 * Moderator tools for the exempt-clan list.
 *
 * The name-in-title check is the one rule that fires on legitimate posts:
 * emoji, full-width characters, a clan whose name is literally blank, a name
 * containing its own `#`. Until moderators can exempt a clan themselves, every
 * one of those needs a code change and a redeploy — which is why this blocks
 * going live on the real subreddit far more than it looks like it should.
 *
 * Two entry points, because there are two moments a moderator wants this:
 *
 * Looking at a post that was wrongly removed, they want the clan exempted with
 * no typing. That is the post-menu action: the tag comes out of the title and
 * the name out of the game API, and all they supply is the reason.
 *
 * Reviewing the list itself, they want to see what is on it and drop entries
 * that no longer belong. That is the subreddit-menu action.
 *
 * The same "add" form serves both, opened empty from the subreddit menu, so a
 * clan can be exempted without waiting for it to post.
 */

export const FORM = {
  exempt: 'exemptClan',
  manage: 'weirdClans',
} as const

/** Field names, shared between the form definitions and their handlers. */
const FIELD = {
  clanTag: 'clanTag',
  clanName: 'clanName',
  reason: 'reason',
  remove: 'remove',
} as const

export type ExemptContext = {
  /** Tag parsed from the post title, if the action came from a post. */
  clanTag?: string
  /** In-game name, when the API could confirm one. */
  clanName?: string
  /** Shown above the form when something needs explaining. */
  note?: string
}

/**
 * Work out what to prefill from the post the moderator was looking at.
 *
 * A tag that resolves to nothing is refused outright: exempting it would put a
 * dead entry on the list that can never match a real post. An API outage is
 * not refused — the tag in the title is still almost certainly right, so the
 * form opens with the name blank and says why.
 */
export function exemptContextFor(
  title: string,
  resolution: ClanResolution | undefined,
): {kind: 'form'; context: ExemptContext} | {kind: 'refuse'; message: string} {
  const candidates = extractClanTagCandidates(title)
  if (candidates.length === 0) {
    return {
      kind: 'refuse',
      message:
        'No clan tag in that title. Open this from the subreddit menu to add ' +
        'a tag by hand.',
    }
  }

  if (resolution?.kind === 'found') {
    return {
      kind: 'form',
      context: {
        clanTag: resolution.clan.tag,
        clanName: resolution.clan.name,
      },
    }
  }

  if (resolution?.kind === 'notFound') {
    return {
      kind: 'refuse',
      message:
        `No clan matches ${candidates.join(' or ')}. An exemption for a tag ` +
        'that does not exist would never match a post — this looks like a ' +
        'genuinely bad tag rather than a name the bot cannot read.',
    }
  }

  return {
    kind: 'form',
    context: {
      clanTag: candidates[0],
      note:
        'The Clash of Clans API is unreachable, so the clan name could not ' +
        'be filled in. Check the tag below before saving.',
    },
  }
}

export function exemptForm(context: ExemptContext = {}): UiResponse {
  const form: Form = {
    title: 'Exempt a clan from the name check',
    description:
      context.note ??
      'Posts for this clan will stop being removed when the clan name is ' +
        'missing from the title. Every other rule still applies.',
    acceptLabel: 'Add to the list',
    fields: [
      {
        type: 'string',
        name: FIELD.clanTag,
        label: 'Clan tag',
        required: true,
        defaultValue: context.clanTag ?? '',
        helpText:
          'Normalised before saving, so #2GQO82YVP and #2GQ082YVP ' +
          'are stored as the same clan.',
      },
      {
        type: 'string',
        name: FIELD.clanName,
        label: 'Clan name',
        defaultValue: context.clanName ?? '',
        helpText: 'Shown when moderators review this list later.',
      },
      {
        type: 'paragraph',
        name: FIELD.reason,
        label: 'Why the name check can never pass',
        required: true,
        helpText:
          'For example: emoji in the name, full-width characters, name is ' +
          'only spaces. A bare tag with no reason is not reviewable later.',
      },
    ],
  }
  return {showForm: {name: FORM.exempt, form}}
}

export type WeirdEntry = {clanTag: string; name?: string; reason?: string}

export function manageForm(entries: readonly WeirdEntry[]): UiResponse {
  if (entries.length === 0) {
    return {
      showToast: {
        text: 'No clans are exempt from the name check yet.',
        appearance: 'neutral',
      },
    }
  }

  const form: Form = {
    title: `${entries.length} clan${entries.length === 1 ? '' : 's'} exempt from the name check`,
    description:
      'Switch a clan on to remove it. The name check will apply to it again.',
    acceptLabel: 'Remove selected',
    cancelLabel: 'Close',
    // One switch per clan rather than a listing plus a dropdown. Reddit renders
    // a form description as a single run of plain text — newlines in it
    // collapse, so ten entries arrive as one unreadable paragraph. A field per
    // entry gets its own line for free, puts the reason in help text under the
    // name it explains, and makes removal a switch beside the clan instead of a
    // separate dropdown the moderator has to cross-reference.
    fields: entries.map(entry => ({
      type: 'boolean' as const,
      name: removeFieldName(entry.clanTag),
      label: label(entry),
      helpText: entry.reason?.trim() ? entry.reason : 'No reason recorded.',
      defaultValue: false,
    })),
  }
  return {showForm: {name: FORM.manage, form}}
}

function label(entry: WeirdEntry): string {
  return entry.name?.trim()
    ? `${entry.clanTag} — ${entry.name}`
    : `${entry.clanTag} — (no name recorded)`
}

/**
 * Field name for one clan's remove switch.
 *
 * The tag travels in the field name because a boolean carries no value of its
 * own, and Supercell's alphabet is uppercase alphanumerics — safe in a key
 * once the leading `#` is dropped.
 */
export function removeFieldName(clanTag: string): string {
  return `${FIELD.remove}_${clanTag.replace(/^#/, '')}`
}

/** Tags whose switch came back on. */
function switchedOn(values: Record<string, unknown>): string[] {
  const prefix = `${FIELD.remove}_`
  return Object.entries(values)
    .filter(([name, value]) => name.startsWith(prefix) && value === true)
    .map(([name]) => name.slice(prefix.length))
    .filter(tag => tag !== '')
    .map(tag => `#${tag}`)
}

/**
 * Values as they arrive from a submitted form.
 *
 * Reddit has sent the values object itself on every submission observed so
 * far, but the wrapped shape costs one line to tolerate and turns a silent
 * no-op into a working action if that ever changes.
 */
export function formValues(body: unknown): Record<string, unknown> {
  if (body == null || typeof body !== 'object') return {}
  const outer = body as Record<string, unknown>
  const inner = outer.values
  return inner != null && typeof inner === 'object'
    ? (inner as Record<string, unknown>)
    : outer
}

export async function submitExempt(body: unknown): Promise<UiResponse> {
  const values = formValues(body)
  const rawTag = text(values[FIELD.clanTag])
  if (rawTag === '') {
    return toast('A clan tag is required.')
  }

  const clanTag = normalizeClanTag(rawTag)
  if (clanTag.length < 4) {
    return toast(`${rawTag} is not a clan tag.`)
  }

  await addWeirdClan(clanTag, {
    name: text(values[FIELD.clanName]) || undefined,
    reason: text(values[FIELD.reason]) || undefined,
  })

  return {
    showToast: {
      text: `${clanTag} is exempt from the name check.`,
      appearance: 'success',
    },
  }
}

export async function submitManage(body: unknown): Promise<UiResponse> {
  const values = formValues(body)
  const selected = switchedOn(values)

  if (selected.length === 0) {
    return toast('Nothing removed.')
  }

  for (const clanTag of selected) await removeWeirdClan(clanTag)

  const remaining = (await listWeirdClans()).length
  return {
    showToast: {
      text:
        `Removed ${selected.join(', ')} — the name check applies again. ` +
        `${remaining} clan${remaining === 1 ? '' : 's'} still exempt.`,
      appearance: 'success',
    },
  }
}

function toast(text: string): UiResponse {
  return {showToast: {text, appearance: 'neutral'}}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
