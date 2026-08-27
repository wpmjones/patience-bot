import assert from 'node:assert/strict'
import {test} from 'node:test'
import {
  absoluteUrl,
  barePostId,
  Category,
  extractClanTag,
  extractClanTagCandidates,
  extractTownHallLevel,
  formatTimeRemaining,
  literalClanTag,
  normalizeClanTag,
  parseCategory,
  titleContainsClanName,
  titleSpellsTagCorrectly,
} from './parse.ts'

// A real title captured from an onPostCreate event.
const LIVE_TITLE =
  '[Recruiting] Black Water | #29LRRULU | TH18+ | Level 28 | War/CWL/Push'

// The examples given verbatim in the subreddit rules.
const RULE_EXAMPLES = [
  '[Recruiting] Awesome Clan| #B3STCL4N | Townhall 6+ | Clan Level 7| Social/Pushing| ACS Verified',
  '[Recruiting] War Clan Inc. | #W4RCL4N | Th 9 to 11 | Clan Level 4 | Arranged Wars/Warring| Independent',
  '[Recruiting] The ABC Family | Alpha Clan | #ABCDCL4N | Townhall 6-15 | Clan Level 10-15 | Social/CWL/Wars',
  '[Searching] Town Hall 12 | 150 | SomeIGN | Clan Level 10 | Competitive',
]

// Same shapes as the rules examples, but with tags drawn from Supercell's
// actual alphabet (0289PYLQGRJCUV).
const REALISTIC_TITLES = [
  '[Recruiting] Awesome Clan| #P0LYCUJ9 | Townhall 6+ | Clan Level 7| Social/Pushing| ACS Verified',
  '[Recruiting] War Clan Inc. | #2QR0QVJ29 | Th 9 to 11 | Clan Level 4 | Arranged Wars/Warring| Independent',
  '[Merging] Some Clan | #29LRRULU | 35 members | Clan Level 12',
]

test('accepts the three categories the rules permit', () => {
  const cases: [string, Category][] = [
    ['[Recruiting] x', Category.Recruiting],
    ['[recruiting] x', Category.Recruiting],
    ['[ RECRUITING ] x', Category.Recruiting],
    ['[Searching] x', Category.Searching],
    ['[Merging] x', Category.Merging],
  ]
  for (const [title, category] of cases) {
    assert.deepEqual(parseCategory(title), {kind: 'ok', category}, title)
  }
})

test('parses the category from a live title', () => {
  assert.deepEqual(parseCategory(LIVE_TITLE), {
    kind: 'ok',
    category: Category.Recruiting,
  })
})

test('requires the tag at the start of the title', () => {
  // Rule: "Each post title must start with one of these tags".
  assert.deepEqual(parseCategory('Awesome Clan [Recruiting] join us'), {
    kind: 'missing',
  })
  assert.deepEqual(parseCategory('No brackets here'), {kind: 'missing'})
})

test('rejects categories outside the rules, including Event Recruiting', () => {
  assert.deepEqual(parseCategory('[Event Recruiting] my event'), {
    kind: 'unknown',
    raw: 'Event Recruiting',
  })
  assert.deepEqual(parseCategory('[Help] something'), {
    kind: 'unknown',
    raw: 'Help',
  })
})

test('extracts and normalises clan tags', () => {
  assert.equal(extractClanTag(LIVE_TITLE), '#29LRRULU')
  assert.equal(extractClanTag('[Recruiting] Clan | 29LRRULU'), undefined)
  assert.equal(extractClanTag('no tag at all'), undefined)
})

test('maps the letter O to zero', () => {
  assert.equal(normalizeClanTag('#2QROQVJ29'), '#2QR0QVJ29')
  assert.equal(normalizeClanTag('2qr0qvj29'), '#2QR0QVJ29')
  assert.equal(normalizeClanTag('#2QR0-QVJ29'), '#2QR0QVJ29')
})

test('returns every tag-shaped candidate, real tag included', () => {
  // Clan names that contain tag-shaped text, taken from weird.json. Taking the
  // first match alone would remove these posts as bad clan tags.
  assert.deepEqual(
    extractClanTagCandidates('[Recruiting] AK47#000 | #2GQO82YVP | TH12'),
    ['#000', '#2GQ082YVP'],
  )
  assert.deepEqual(
    extractClanTagCandidates('[Recruiting] ##Jockerzz## | #2YPUJ8QU8 | TH12'),
    ['#J0C', '#2YPUJ8QU8'],
  )
  // A clan whose name repeats its own tag collapses to one candidate.
  assert.deepEqual(
    extractClanTagCandidates('[Recruiting] Clan #2L920GL2Q | #2L920GL2Q | TH9'),
    ['#2L920GL2Q'],
  )
})

test('the ordinary single-tag case is unchanged', () => {
  assert.deepEqual(extractClanTagCandidates(LIVE_TITLE), ['#29LRRULU'])
  assert.deepEqual(extractClanTagCandidates('no tag at all'), [])
})

test('rescues the #coc special case', () => {
  assert.equal(
    extractClanTag('[Recruiting] Some Clan #coc join us 2QR0QVJ29'),
    '#2QR0QVJ29',
  )
  assert.equal(extractClanTag('[Recruiting] Some Clan #coc'), '#C0C')
})

test('finds clan tags in rules-shaped titles', () => {
  assert.equal(extractClanTag(REALISTIC_TITLES[0] ?? ''), '#P0LYCUJ9')
  assert.equal(extractClanTag(REALISTIC_TITLES[1] ?? ''), '#2QR0QVJ29')
  assert.equal(extractClanTag(REALISTIC_TITLES[2] ?? ''), '#29LRRULU')
})

test('the tags in the posted rules examples are not real clan tags', () => {
  // B3STCL4N / W4RCL4N / ABCDCL4N are leetspeak placeholders using B, S, T, N,
  // 3 and 4 — none of which exist in Supercell's alphabet (0289PYLQGRJCUV).
  // Documented as a test so it doesn't get mistaken for a parser bug later.
  assert.equal(extractClanTag(RULE_EXAMPLES[0] ?? ''), undefined)
  assert.equal(extractClanTag(RULE_EXAMPLES[1] ?? ''), undefined)
  assert.equal(extractClanTag(RULE_EXAMPLES[2] ?? ''), undefined)
})

test('extracts Town Hall level for Searching posts', () => {
  assert.equal(extractTownHallLevel('[Searching] TH12 | 150 | IGN'), 12)
  assert.equal(extractTownHallLevel('[Searching] th 9 | 100 | IGN'), 9)
  assert.equal(extractTownHallLevel('[Searching] Town Hall 12 | 150'), 12)
  assert.equal(extractTownHallLevel('[Searching] T.H. 15 | 200'), 15)
  // Bare number in the first field, which the rules' format implies.
  assert.equal(extractTownHallLevel('[Searching] 12 | 150 | IGN'), 12)
  assert.equal(
    extractTownHallLevel('[Searching] looking for a clan'),
    undefined,
  )
})

test('finds the clan name in a live title', () => {
  assert.equal(titleContainsClanName('Black Water', LIVE_TITLE), true)
  assert.equal(
    titleContainsClanName('Black Water', '[Recruiting] Reddit Warriors'),
    false,
  )
})

test('a digit swapped for a letter is NOT the same clan name', () => {
  // The case that got through fuzzy matching: "Reddit Omega" is 12 characters,
  // so a one-edit-per-four budget allowed both the O->0 and the e->3.
  assert.equal(
    titleContainsClanName(
      'Reddit Omega',
      '[Recruiting] Reddit 0m3ga | #UQV9LLY | Wrong name',
    ),
    false,
  )
  assert.equal(
    titleContainsClanName(
      'Reddit Omega',
      '[Recruiting] Reddit Omega | #UQV9LLY',
    ),
    true,
  )
})

test('presentation differences are still forgiven', () => {
  // Case, spacing, and a curly apostrophe against the API's straight one.
  assert.equal(
    titleContainsClanName('Black Water', '[Recruiting] BLACKWATER'),
    true,
  )
  assert.equal(
    titleContainsClanName(
      "G3's Clan",
      '[Recruiting] G3\u2019s Clan | #2YJJUVG0C',
    ),
    true,
  )
  // Full-width characters fold to their plain forms under NFKC.
  assert.equal(
    titleContainsClanName(
      'Incognito',
      '[Recruiting] \uff29\uff4e\uff43\uff4f\uff47\uff4e\uff49\uff54\uff4f | #2QG8VVGJU',
    ),
    true,
  )
})

test('a typo in the clan name goes to the moderators', () => {
  // Deliberately strict: a dropped letter is indistinguishable from an
  // impersonation attempt, so both get a human look.
  assert.equal(
    titleContainsClanName('Black Water', '[Recruiting] Black Watr'),
    false,
  )
})

test('finds the clan name in a clan family title', () => {
  // The main clan's name, alongside the family name.
  assert.equal(
    titleContainsClanName('Alpha Clan', RULE_EXAMPLES[2] ?? ''),
    true,
  )
})

test('formats the time remaining the way removal comments read', () => {
  const ms = (3 * 86400 + 4 * 3600 + 12 * 60) * 1000
  assert.equal(formatTimeRemaining(ms), '3 days, 4 hours, 12 minutes')
  assert.equal(formatTimeRemaining(0), '0 days, 0 hours, 0 minutes')
  assert.equal(formatTimeRemaining(-5000), '0 days, 0 hours, 0 minutes')
})

test('normalises post ids and urls', () => {
  assert.equal(barePostId('t3_1vxm5ep'), '1vxm5ep')
  assert.equal(barePostId('1vxm5ep'), '1vxm5ep')
  assert.equal(
    absoluteUrl('/r/PatienceBotTest/comments/1vxm5ep/x/'),
    'https://www.reddit.com/r/PatienceBotTest/comments/1vxm5ep/x/',
  )
  assert.equal(absoluteUrl('https://example.com/x'), 'https://example.com/x')
})

test('detects when the title spells the clan tag wrong but recoverably', () => {
  // The real tag is #2GQ082YVP; weird.json itself records it with a letter O.
  const wrong = '[Recruiting] AK47#000 | #2GQO82YVP | TH12'
  const right = '[Recruiting] AK47#000 | #2GQ082YVP | TH12'
  assert.equal(titleSpellsTagCorrectly(wrong, '#2GQ082YVP'), false)
  assert.equal(titleSpellsTagCorrectly(right, '#2GQ082YVP'), true)
  // Case and punctuation are cosmetic, not a typo worth commenting on.
  assert.equal(
    titleSpellsTagCorrectly('[Recruiting] x | #2gq082yvp', '#2GQ082YVP'),
    true,
  )
})

test('literalClanTag leaves a letter O alone', () => {
  assert.equal(literalClanTag('#2GQO82YVP'), '#2GQO82YVP')
  assert.equal(normalizeClanTag('#2GQO82YVP'), '#2GQ082YVP')
})
