import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {Clan, ClanResolution} from './coc.ts'
import {COOLDOWN_MS} from './db.ts'
import {type Deps, decide, type Effect, type PostFacts} from './decide.ts'

const NOW = 1787625315000
const DAY = 24 * 60 * 60 * 1000

const BLACK_WATER: Clan = {
  tag: '#29LRRULU',
  name: 'Black Water',
  level: 28,
  members: 47,
}

function facts(overrides: Partial<PostFacts> = {}): PostFacts {
  return {
    postId: 't3_new',
    title: '[Recruiting] Black Water | #29LRRULU | TH18 | Level 28 | War',
    body: 'Active war clan, all welcome.',
    author: 'TubaKid44',
    createdAt: NOW,
    url: 'https://www.reddit.com/r/x/comments/new/',
    subredditName: 'ClashOfClansRecruit',
    ...overrides,
  }
}

function deps(overrides: Partial<Deps> = {}): Deps {
  return {
    now: NOW,
    hasSeenPost: async () => false,
    resolveClan: async (): Promise<ClanResolution> => ({
      kind: 'found',
      clan: BLACK_WATER,
    }),
    lastTrackedForClan: async () => undefined,
    lastTrackedForAuthor: async () => undefined,
    isWeirdClan: async () => false,
    isAuthorKnown: async () => true,
    ...overrides,
  }
}

const kinds = (effects: Effect[]): string[] => effects.map(e => e.kind)

function removalReason(effects: Effect[]): string | undefined {
  const removal = effects.find(e => e.kind === 'remove')
  return removal?.kind === 'remove' ? removal.reason.code : undefined
}

// --- gatekeeping ---

test('a post already processed produces no effects at all', async () => {
  const decision = await decide(facts(), deps({hasSeenPost: async () => true}))
  assert.deepEqual(decision.effects, [])
})

test('a title with no category tag is removed', async () => {
  const decision = await decide(facts({title: 'Join my clan!'}), deps())
  assert.equal(removalReason(decision.effects), 'missingCategory')
})

test('a category outside the rules is removed and quoted', async () => {
  const decision = await decide(
    // A category the subreddit retired; posters still type it from memory.
    facts({title: '[Event Recruiting] come to my event'}),
    deps(),
  )
  const removal = decision.effects.find(e => e.kind === 'remove')
  assert.equal(
    removal?.kind === 'remove' && removal.reason.code === 'unknownCategory'
      ? removal.reason.raw
      : undefined,
    'Event Recruiting',
  )
})

test('a removal records the post as untracked so it cannot anchor a cooldown', async () => {
  const decision = await decide(facts({title: 'no category'}), deps())
  const record = decision.effects.find(e => e.kind === 'record')
  assert.equal(record?.kind === 'record' ? record.record.tracked : true, false)
})

// --- clan posts ---

test('a clean recruiting post is accepted and recorded as tracked', async () => {
  const decision = await decide(facts(), deps())

  assert.deepEqual(kinds(decision.effects), ['record', 'markKnown'])
  const record = decision.effects.find(e => e.kind === 'record')
  assert.equal(record?.kind === 'record' ? record.record.tracked : false, true)
  assert.equal(
    record?.kind === 'record' ? record.record.clanTag : undefined,
    '#29LRRULU',
  )
})

test('a tag that resolves to nothing is removed with the tags tried', async () => {
  const decision = await decide(
    facts(),
    deps({
      resolveClan: async () => ({kind: 'notFound', tried: ['#000', '#J0C']}),
    }),
  )
  const removal = decision.effects.find(e => e.kind === 'remove')
  assert.deepEqual(
    removal?.kind === 'remove' && removal.reason.code === 'badClanTag'
      ? removal.reason.tried
      : [],
    ['#000', '#J0C'],
  )
})

test('an API failure never removes a post and never records it', async () => {
  // The single most dangerous case: treating "the API is down" as "bad tag"
  // would remove every recruiting post on the subreddit.
  const decision = await decide(
    facts(),
    deps({
      resolveClan: async () => ({
        kind: 'unresolved',
        reason: {kind: 'unauthorized', message: 'HTTP 403'},
      }),
    }),
  )

  assert.deepEqual(kinds(decision.effects), ['alert'])
  const alert = decision.effects.find(e => e.kind === 'alert')
  assert.equal(
    alert?.kind === 'alert' ? alert.alertKey : '',
    'coc-unauthorized',
  )
  assert.match(
    alert?.kind === 'alert' ? alert.detail : '',
    /NOT being checked or removed/,
  )
})

test('a second post for the same clan inside the window is removed', async () => {
  const decision = await decide(
    facts(),
    deps({
      lastTrackedForClan: async () => ({postId: 'old', created: NOW - 2 * DAY}),
    }),
  )
  const removal = decision.effects.find(e => e.kind === 'remove')
  assert.equal(
    removal?.kind === 'remove' ? removal.reason.code : '',
    'cooldown',
  )
  assert.match(
    removal?.kind === 'remove' && removal.reason.code === 'cooldown'
      ? (removal.reason.previousUrl ?? '')
      : '',
    /comments\/old/,
  )
})

test('a post just past the window is accepted', async () => {
  const decision = await decide(
    facts(),
    deps({
      lastTrackedForClan: async () => ({
        postId: 'old',
        created: NOW - COOLDOWN_MS - 1000,
      }),
    }),
  )
  assert.equal(removalReason(decision.effects), undefined)
})

test('the cooldown is judged against the post time, not the clock', async () => {
  // A reconciliation run hours later must judge the post as it stood when made.
  const decision = await decide(
    facts({createdAt: NOW - 5 * DAY}),
    deps({
      now: NOW,
      lastTrackedForClan: async () => ({
        postId: 'old',
        created: NOW - 12 * DAY,
      }),
    }),
  )
  assert.equal(
    removalReason(decision.effects),
    undefined,
    'seven days elapsed at post time, so it was legal then',
  )
})

test('a clan name that cannot be confirmed is removed', async () => {
  const decision = await decide(
    facts({title: '[Recruiting] Totally Different | #29LRRULU | TH18'}),
    deps(),
  )

  const removal = decision.effects.find(e => e.kind === 'remove')
  assert.equal(
    removal?.kind === 'remove' ? removal.reason.code : '',
    'clanNameMismatch',
  )
  assert.equal(
    removal?.kind === 'remove' && removal.reason.code === 'clanNameMismatch'
      ? removal.reason.clanName
      : '',
    'Black Water',
  )
  // Untracked, so a corrected repost today is not blocked by this one.
  const record = decision.effects.find(e => e.kind === 'record')
  assert.equal(record?.kind === 'record' ? record.record.tracked : true, false)
})

test('the removal carries the clan so Discord can show it', async () => {
  const decision = await decide(
    facts({title: '[Recruiting] Totally Different | #29LRRULU | TH18'}),
    deps(),
  )
  const removal = decision.effects.find(e => e.kind === 'remove')
  assert.equal(
    removal?.kind === 'remove' ? removal.clan?.name : '',
    'Black Water',
  )
})

test('a clan on the exempt list survives an unconfirmable name', async () => {
  const decision = await decide(
    facts({title: '[Recruiting] Totally Different | #29LRRULU | TH18'}),
    deps({isWeirdClan: async () => true}),
  )
  assert.equal(removalReason(decision.effects), undefined)
})

test('the name check runs before the cooldown, so a fix can be reposted', async () => {
  // Otherwise a user correcting their title would be told to wait a week for
  // the very post that was just removed for being wrong.
  const decision = await decide(
    facts({title: '[Recruiting] Totally Different | #29LRRULU | TH18'}),
    deps({
      lastTrackedForClan: async () => ({postId: 'old', created: NOW - 1000}),
    }),
  )
  assert.equal(removalReason(decision.effects), 'clanNameMismatch')
})

// Black Water's tag has no zero in it, so it cannot be O-typo'd. Tag-repair
// cases need a clan whose tag actually contains one — using Black Water here
// let a broken decision pass, because the stub resolver ignores its argument.
const WAR_CLAN: Clan = {
  tag: '#2QR0QVJ29',
  name: 'War Clan Inc.',
  level: 4,
  members: 30,
}

test('a repaired tag gets a comment when the title is otherwise fine', async () => {
  const decision = await decide(
    facts({title: '[Recruiting] War Clan Inc. | #2QROQVJ29 | TH18'}),
    deps({resolveClan: async () => ({kind: 'found', clan: WAR_CLAN})}),
  )

  const notice = decision.effects.find(e => e.kind === 'notice')
  assert.equal(notice?.kind === 'notice' ? notice.notice.kind : '', 'tagTypo')
  assert.equal(removalReason(decision.effects), undefined)
})

test('the tag-typo comment quotes two different tags', async () => {
  // Shipped once quoting the normalised candidate as the "typed" tag, so the
  // comment read "your title lists #X, but the actual tag is #X".
  const decision = await decide(
    facts({title: '[Recruiting] War Clan Inc. | #2QROQVJ29 | TH18'}),
    deps({resolveClan: async () => ({kind: 'found', clan: WAR_CLAN})}),
  )

  const notice = decision.effects.find(
    e => e.kind === 'notice' && e.notice.kind === 'tagTypo',
  )
  assert.ok(notice?.kind === 'notice' && notice.notice.kind === 'tagTypo')
  assert.equal(notice.notice.typed, '#2QROQVJ29')
  assert.equal(notice.notice.actual, '#2QR0QVJ29')
  assert.notEqual(notice.notice.typed, notice.notice.actual)
})

test('a rescued tag is not reported as a typo', async () => {
  // #coc resolves via TAG_RESCUES, so nothing in the title is the author's
  // misspelling of the real tag. Silence beats an incoherent comment.
  const decision = await decide(
    facts({title: '[Recruiting] War Clan Inc. #coc | TH18'}),
    deps({resolveClan: async () => ({kind: 'found', clan: WAR_CLAN})}),
  )
  const notices = decision.effects.filter(
    e => e.kind === 'notice' && e.notice.kind === 'tagTypo',
  )
  assert.deepEqual(notices, [])
})

test('a removed post is not also nagged about its tag', async () => {
  const decision = await decide(
    facts({title: '[Recruiting] Totally Different | #29LRRULO | TH18'}),
    deps(),
  )
  assert.equal(removalReason(decision.effects), 'clanNameMismatch')
  const notices = decision.effects.filter(e => e.kind === 'notice')
  assert.equal(notices.length, 0)
})

// --- searching posts ---

test('a searching post with no Town Hall level is removed', async () => {
  const decision = await decide(
    facts({title: '[Searching] looking for an active clan'}),
    deps(),
  )
  assert.equal(removalReason(decision.effects), 'missingTownHall')
})

test('a searching post is rate limited by author, not clan', async () => {
  const decision = await decide(
    facts({title: '[Searching] TH12 | 150 | SomeIGN'}),
    deps({
      lastTrackedForClan: async () => ({postId: 'clan', created: NOW}),
      lastTrackedForAuthor: async () => ({
        postId: 'mine',
        created: NOW - 1 * DAY,
      }),
    }),
  )
  const removal = decision.effects.find(e => e.kind === 'remove')
  assert.equal(
    removal?.kind === 'remove' ? removal.reason.code : '',
    'cooldown',
  )
  assert.match(
    removal?.kind === 'remove' && removal.reason.code === 'cooldown'
      ? (removal.reason.previousUrl ?? '')
      : '',
    /comments\/mine/,
  )
})

test('a searching post from a deleted account is recorded but untracked', async () => {
  const decision = await decide(
    facts({title: '[Searching] TH12 | 150 | IGN', author: undefined}),
    deps(),
  )
  assert.deepEqual(kinds(decision.effects), ['record'])
  const record = decision.effects.find(e => e.kind === 'record')
  assert.equal(record?.kind === 'record' ? record.record.tracked : true, false)
})

// --- welcome ---

test('a first-time author is welcomed when their post survives', async () => {
  const decision = await decide(
    facts(),
    deps({isAuthorKnown: async () => false}),
  )
  const notice = decision.effects.find(e => e.kind === 'notice')
  assert.equal(notice?.kind === 'notice' ? notice.notice.kind : '', 'welcome')
})

test('a first-time author whose post is removed is not welcomed', async () => {
  // They already receive a message explaining exactly what went wrong; a
  // "welcome, here are the rules" on top of it reads as tone-deaf. They stay
  // unknown, so the welcome lands on their first post that survives.
  const decision = await decide(
    facts({title: 'no category here'}),
    deps({isAuthorKnown: async () => false}),
  )
  const notices = decision.effects.filter(e => e.kind === 'notice')
  assert.equal(notices.length, 0)
  assert.ok(!kinds(decision.effects).includes('markKnown'))
})

test('a known author is not welcomed again', async () => {
  const decision = await decide(
    facts(),
    deps({isAuthorKnown: async () => true}),
  )
  const notices = decision.effects.filter(e => e.kind === 'notice')
  assert.equal(notices.length, 0)
})

test('a searching first-timer is welcomed too', async () => {
  const decision = await decide(
    facts({title: '[Searching] TH12 | 150 | IGN'}),
    deps({isAuthorKnown: async () => false}),
  )
  const notice = decision.effects.find(e => e.kind === 'notice')
  assert.equal(notice?.kind === 'notice' ? notice.notice.kind : '', 'welcome')
})

// --- rule terms ---

test('a post mentioning selling goes to the mod queue, not removed', async () => {
  const decision = await decide(
    facts({body: 'DM me if you want to buy a maxed account, cheap gems too.'}),
    deps(),
  )

  assert.equal(removalReason(decision.effects), undefined)
  const report = decision.effects.find(e => e.kind === 'report')
  assert.equal(
    report?.kind === 'report' && report.flag.code === 'prohibitedTerms'
      ? [...report.flag.terms].sort().join(',')
      : '',
    'buy,gems',
  )
})

test('rule terms are found in the title as well as the body', async () => {
  const decision = await decide(
    facts({title: '[Recruiting] Black Water | #29LRRULU | free giveaways!'}),
    deps(),
  )
  const report = decision.effects.find(e => e.kind === 'report')
  assert.equal(
    report?.kind === 'report' && report.flag.code === 'prohibitedTerms'
      ? report.flag.terms.join(',')
      : '',
    'giveaways',
  )
})

test("a rule term inside the clan's own name is ignored", async () => {
  // "Gem Traders" would otherwise trip on two terms every single time it posts.
  const decision = await decide(
    facts({
      title: '[Recruiting] Gem Traders | #29LRRULU | TH18',
      body: 'Competitive war clan.',
    }),
    deps({
      resolveClan: async () => ({
        kind: 'found',
        clan: {tag: '#29LRRULU', name: 'Gem Traders', level: 1, members: 10},
      }),
    }),
  )
  assert.ok(!kinds(decision.effects).includes('report'))
})

test('the same term outside the clan name is still caught', async () => {
  const decision = await decide(
    facts({
      title: '[Recruiting] Gem Traders | #29LRRULU | TH18',
      body: 'Selling accounts, message me.',
    }),
    deps({
      resolveClan: async () => ({
        kind: 'found',
        clan: {tag: '#29LRRULU', name: 'Gem Traders', level: 1, members: 10},
      }),
    }),
  )
  const report = decision.effects.find(e => e.kind === 'report')
  assert.equal(
    report?.kind === 'report' && report.flag.code === 'prohibitedTerms'
      ? report.flag.terms.join(',')
      : '',
    'selling',
  )
})

test('searching posts are checked for rule terms too', async () => {
  const decision = await decide(
    facts({
      title: '[Searching] TH12 | 150 | SomeIGN',
      body: 'Will pay gems for a good clan.',
    }),
    deps(),
  )
  assert.ok(kinds(decision.effects).includes('report'))
})

test('an ordinary post triggers nothing', async () => {
  const decision = await decide(facts(), deps())
  assert.ok(!kinds(decision.effects).includes('report'))
})
