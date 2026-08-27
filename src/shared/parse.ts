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
 * How the author actually spelled the tag that resolved to `realTag`.
 *
 * Quoting a normalised candidate back at the author is useless — normalisation
 * is exactly what repaired the spelling, so the "wrong" tag and the right one
 * print identically. This walks back to the raw substring, keeping every
 * character the author typed except the cosmetic ones (case, punctuation, the
 * leading #) that were never the complaint.
 *
 * Returns undefined when nothing in the title maps to `realTag` — a rescued
 * tag, where there is no author spelling to quote.
 */
export function typedSpellingOf(
  title: string,
  realTag: string,
): string | undefined {
  const raw = rawClanTagMatches(title).find(
    raw => normalizeClanTag(raw) === realTag && literalClanTag(raw) !== realTag,
  )
  return raw == null ? undefined : literalClanTag(raw)
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
 * Fold away differences in how text is *rendered*, while leaving differences
 * in what the characters actually *are*.
 *
 * NFKC collapses full-width and compatibility forms, so the clan displayed as
 * "Ｉｎｃｏｇｎｉｔｏ" matches "Incognito". Curly quotes, typographic dashes,
 * case and whitespace are all presentational and get normalised too — the API
 * returns "G3\'s Clan" with a straight apostrophe while a phone keyboard types
 * a curly one, and neither is a different name.
 *
 * Digit-for-letter swaps are deliberately NOT folded. "Reddit 0m3ga" is not
 * "Reddit Omega": it is a different string that happens to look similar, and
 * telling those apart is the entire point of this check.
 */
function foldForComparison(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc\u2032\u00b4`]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, '')
}

/**
 * Does the title contain the clan's name, exactly?
 *
 * This used to allow one edit per four characters, which let "Reddit 0m3ga"
 * pass as "Reddit Omega" — two character substitutions inside a three-edit
 * budget. Approximate matching cannot distinguish a harmless typo from a
 * deliberate impersonation, so it does not try: anything that is not the name
 * goes to the moderators, who can approve it in a click.
 *
 * Clans whose real name can never appear in a title — emoji-only names, blank
 * names, non-Latin alphabets — belong on the weird-clan exempt list instead.
 */
export function titleContainsClanName(
  clanName: string,
  title: string,
): boolean {
  const needle = foldForComparison(clanName)
  if (needle === '') return false
  return foldForComparison(title).includes(needle)
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

/**
 * Terms from the subreddit's no-trading rule:
 *
 *   "No buying, selling, trading, begging, giveaways, or gifting. No contests
 *    or events which offer prizes... No buying or selling or transfer of
 *    accounts, clans, gems, services, or other in game items."
 *
 * Written as stems so ordinary inflections are caught without listing each
 * form. Deliberately narrow: "donations" is left out because troop donations
 * are the single most common thing a recruiting post advertises, and flagging
 * every one of them would bury the moderators.
 */
const PROHIBITED_PATTERNS: readonly string[] = [
  'giveaways?',
  'gift(?:ing|ed|s)?',
  'buy(?:ing|s)?',
  'sell(?:ing|s)?',
  'trad(?:e|es|ing)',
  'gems?',
  'begging',
]

const PROHIBITED_RE = new RegExp(
  `\\b(?:${PROHIBITED_PATTERNS.join('|')})\\b`,
  'gi',
)

/**
 * Find rule-violating terms in a post, ignoring any that are part of the clan's
 * own name.
 *
 * Context is the whole difficulty here. A clan legitimately called "Gem
 * Traders" would otherwise trip on two terms every time it posts, so its name
 * is subtracted from the text before the search runs. What remains is prose the
 * author actually wrote.
 *
 * This only ever routes a post to a human — the terms have innocent uses
 * ("gem mine level 10") that no word list can distinguish from the real thing.
 */
export function findProhibitedTerms(text: string, clanName?: string): string[] {
  let haystack = text.normalize('NFKC').toLowerCase()

  const name = clanName?.normalize('NFKC').toLowerCase().trim()
  if (name != null && name !== '') {
    haystack = haystack.split(name).join(' ')
  }

  const found = new Set<string>()
  for (const match of haystack.matchAll(PROHIBITED_RE)) found.add(match[0])
  return [...found].sort()
}
