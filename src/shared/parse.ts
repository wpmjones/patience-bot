/**
 * Title parsing for r/ClashOfClansRecruit, derived from the subreddit's posted
 * rules rather than from the previous Python implementation.
 *
 * Rules being encoded:
 *   - Every title must START with [Recruiting], [Searching], or [Merging].
 *   - [Recruiting] and [Merging] titles must contain the exact clan name and
 *     clan tag.
 *   - [Searching] titles must contain the poster's Town Hall level.
 *
 * Nothing here touches Redis, Reddit, or the network, so it is all directly
 * unit testable — which matters, because a bug in this file auto-removes
 * legitimate posts.
 */

/** The only categories the subreddit rules permit. */
export type Category = (typeof Category)[keyof typeof Category]
export const Category = {
  Recruiting: 'Recruiting',
  Searching: 'Searching',
  Merging: 'Merging',
} as const

/** Tracked by clan tag: one post per clan per cooldown. */
export const CLAN_CATEGORIES: readonly Category[] = [
  Category.Recruiting,
  Category.Merging,
]

/** Tracked by post author: one post per person per cooldown. */
export const AUTHOR_CATEGORIES: readonly Category[] = [Category.Searching]

/** Anchored: the rules say the title must *start* with the tag. */
const CATEGORY_RE = /^\s*\[([^\]]*)\]/
const CLAN_TAG_RE = /#[PYLQGRJCUV0289OI]{3,9}/gi
const TOWN_HALL_RE = /\b(?:t\.?\s*h\.?|town\s*hall)\s*\.?\s*(\d{1,2})\b/i

const CATEGORY_BY_KEY: Readonly<Record<string, Category>> = {
  recruiting: Category.Recruiting,
  searching: Category.Searching,
  merging: Category.Merging,
}

/**
 * The outcome of reading the leading bracketed tag.
 *
 * `missing` and `unknown` both lead to removal, but they get different messages
 * — "you didn't use a category" reads very differently from "[Help] isn't one
 * of the three".
 */
export type CategoryResult =
  | {kind: 'ok'; category: Category}
  | {kind: 'missing'}
  | {kind: 'unknown'; raw: string}

export function parseCategory(title: string): CategoryResult {
  const match = CATEGORY_RE.exec(title)
  const raw = match?.[1]
  if (raw == null) return {kind: 'missing'}

  const key = raw.replace(/\s+/g, '').toLowerCase()
  const category = CATEGORY_BY_KEY[key]
  if (category == null) return {kind: 'unknown', raw: raw.trim()}
  return {kind: 'ok', category}
}

/**
 * Normalise a clan tag: uppercase, drop separators, map the letter O to zero,
 * and guarantee a leading #.
 *
 * The letter I is matched by CLAN_TAG_RE but has no valid correction — it is
 * not in Supercell's alphabet (0289PYLQGRJCUV) and there is no 1 to map it to.
 * That is intentional: matching it means an I-containing tag is caught here and
 * rejected by the API as a bad clan tag, rather than looking like no tag was
 * present at all.
 */
export function normalizeClanTag(tag: string): string {
  const body = tag
    .toUpperCase()
    .replace(/^#/, '')
    .replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0')
  return `#${body}`
}

/**
 * Titles where the first regex match is not the real clan tag.
 *
 * Keyed by the normalised bad match; only applied when the title also contains
 * the replacement tag's body.
 */
const TAG_RESCUES: Readonly<Record<string, string>> = {
  '#C0C': '#2QR0QVJ29',
}

/**
 * Every clan-tag-shaped substring in the title, normalised and deduplicated,
 * in the order a reader would encounter them.
 *
 * Returning candidates rather than a single guess matters because clan *names*
 * can contain tag-shaped text. "AK47#000" yields #000 and "##Jockerzz##" yields
 * #J0C, both ahead of the real tag. Taking the first match removes those posts
 * as bad tags; trying each against the API and keeping the first that resolves
 * handles them without any per-clan special casing.
 *
 * The common case is a single candidate, so this costs nothing extra there.
 */
export function extractClanTagCandidates(title: string): string[] {
  const matches = title.match(CLAN_TAG_RE) ?? []
  const candidates: string[] = []

  const add = (tag: string): void => {
    if (tag.length > 1 && !candidates.includes(tag)) candidates.push(tag)
  }

  for (const match of matches) {
    const tag = normalizeClanTag(match)
    // A rescue outranks the literal match it was triggered by.
    const rescue = TAG_RESCUES[tag]
    if (rescue != null && title.toUpperCase().includes(rescue.slice(1))) {
      add(rescue)
    }
    add(tag)
  }
  return candidates
}

/**
 * The first candidate, for logging and display.
 *
 * Decision logic should use extractClanTagCandidates and let the API pick.
 */
export function extractClanTag(title: string): string | undefined {
  return extractClanTagCandidates(title)[0]
}

/** Tag-shaped substrings exactly as they appear in the title. */
export function rawClanTagMatches(title: string): string[] {
  return title.match(CLAN_TAG_RE) ?? []
}

/**
 * Normalisation *without* the O-to-zero substitution.
 *
 * Comparing this against the tag the API returned tells us whether the user
 * actually typed their clan tag correctly. If `literalClanTag(raw)` differs
 * from the real tag but the clan still resolved, the only possible difference
 * is a letter O standing in for a zero — every other normalisation step
 * (case, punctuation, the leading #) is cosmetic.
 */
export function literalClanTag(tag: string): string {
  return `#${tag
    .toUpperCase()
    .replace(/^#/, '')
    .replace(/[^A-Z0-9]/g, '')}`
}

/**
 * Did the title spell the clan's tag correctly?
 *
 * False means the clan was found only because normalisation repaired the tag,
 * so the tag printed in the title is wrong even though the post is valid.
 */
export function titleSpellsTagCorrectly(
  title: string,
  realTag: string,
): boolean {
  return rawClanTagMatches(title).some(raw => literalClanTag(raw) === realTag)
}

/**
 * Town Hall level for [Searching] posts.
 *
 * Handles the common spellings (TH12, th 12, Town Hall 12, T.H. 12) and falls
 * back to a bare number in the first pipe-delimited field, since the rules put
 * the Town Hall level there.
 */
export function extractTownHallLevel(title: string): number | undefined {
  const match = TOWN_HALL_RE.exec(title)
  const raw = match?.[1]
  if (raw != null) return validLevel(Number(raw))

  const body = title.replace(CATEGORY_RE, '')
  const first = body.split('|')[0]?.trim()
  if (first != null && /^\d{1,2}$/.test(first)) return validLevel(Number(first))

  return undefined
}

/**
 * Upper bound for a plausible Town Hall level.
 *
 * The real maximum is 18 as of 2026, but Supercell adds levels over time and a
 * too-tight ceiling would start auto-removing legitimate posts the day a new
 * one ships. Kept deliberately loose — this only needs to reject numbers that
 * clearly are not Town Hall levels.
 */
export const MAX_TOWN_HALL = 25

function validLevel(level: number): number | undefined {
  return level >= 1 && level <= MAX_TOWN_HALL ? level : undefined
}

/**
 * Approximate substring search — the equivalent of Python's
 * `fuzzysearch.find_near_matches(needle, haystack, max_l_dist=maxDistance)`.
 *
 * Sellers' algorithm: a Levenshtein DP whose first row is all zeros, so a match
 * may begin at any offset in the haystack. Returns true as soon as some
 * substring of `haystack` is within `maxDistance` edits of `needle`.
 */
export function fuzzyContains(
  needle: string,
  haystack: string,
  maxDistance: number,
): boolean {
  const n = needle.length
  if (n === 0) return true
  // Every character could be deleted, so the empty substring already matches.
  if (maxDistance >= n) return true

  let prev = new Int32Array(n + 1)
  let cur = new Int32Array(n + 1)
  for (let i = 0; i <= n; i++) prev[i] = i

  for (let j = 0; j < haystack.length; j++) {
    const hc = haystack.charCodeAt(j)
    cur[0] = 0
    let last = 0
    for (let i = 1; i <= n; i++) {
      const cost = needle.charCodeAt(i - 1) === hc ? 0 : 1
      const del = (prev[i] ?? 0) + 1
      const ins = (cur[i - 1] ?? 0) + 1
      const sub = (prev[i - 1] ?? 0) + cost
      last = Math.min(del, ins, sub)
      cur[i] = last
    }
    if (last <= maxDistance) return true
    const swap = prev
    prev = cur
    cur = swap
  }
  return false
}

/**
 * Does the title contain the clan's name?
 *
 * The rules say "exact clan name", but enforcing that literally would remove
 * posts over a stray apostrophe or emoji, so this allows one edit per four
 * characters — the same tolerance the Python bot used in practice.
 */
export function titleContainsClanName(
  clanName: string,
  title: string,
): boolean {
  const needle = clanName.trim().toLowerCase()
  if (!needle) return false
  return fuzzyContains(
    needle,
    title.toLowerCase(),
    Math.floor(needle.length / 4),
  )
}

/** "3 days, 4 hours, 12 minutes" — the wording used in removal comments. */
export function formatTimeRemaining(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const days = Math.floor(total / 86400)
  const hours = Math.floor(total / 3600) % 24
  const minutes = Math.floor(total / 60) % 60
  return `${days} days, ${hours} hours, ${minutes} minutes`
}

export const REDDIT_BASE = 'https://www.reddit.com'

/** Trigger payloads carry a relative path; Discord embeds need a full URL. */
export function absoluteUrl(pathOrUrl: string): string {
  return pathOrUrl.startsWith('http') ? pathOrUrl : `${REDDIT_BASE}${pathOrUrl}`
}

/**
 * Strip Reddit's `t3_` fullname prefix.
 *
 * Trigger payloads give `t3_1vxm5ep`; the Postgres pb_coc table stores bare
 * ids like `1vxm5ep`. The seed import has to agree with this on one form.
 */
export function barePostId(id: string): string {
  return id.replace(/^t3_/, '')
}
