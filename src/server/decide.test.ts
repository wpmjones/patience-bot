import assert from 'node:assert/strict'
import {test} from 'node:test'
import {Category} from '../shared/parse.ts'
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

test('a missing clan name is reported to the mod queue, not removed', async () => {
  const decision = await decide(
    facts({title: '[Recruiting] Totally Different | #29LRRULU | TH18'}),
    deps(),
  )

  assert.equal(removalReason(decision.effects), undefined)
  assert.ok(kinds(decision.effects).includes('report'))
  const report = decision.effects.find(e => e.kind === 'report')
  assert.match(report?.kind === 'report' ? report.reason : '', /Black Water/)
  // Still tracked: the post is live, so it holds the clan's slot.
  const record = decision.effects.find(e => e.kind === 'record')
  assert.equal(record?.kind === 'record' ? record.record.tracked : false, true)
})

test('a clan on the exempt list is never reported for its name', async () => {
  const decision = await decide(
    facts({title: '[Recruiting] Totally Different | #29LRRULU | TH18'}),
    deps({isWeirdClan: async () => true}),
  )
  assert.ok(!kinds(decision.effects).includes('report'))
})

test('a repaired tag gets a comment when the title is otherwise fine', async () => {
  const decision = await decide(
    facts({title: '[Recruiting] Black Water | #29LRRULO | TH18'}),
    deps(),
  )

  const notice = decision.effects.find(e => e.kind === 'notice')
  assert.equal(notice?.kind === 'notice' ? notice.notice.kind : '', 'tagTypo')
  assert.equal(removalReason(decision.effects), undefined)
})

test('a post already in the mod queue is not also nagged about its tag', async () => {
  const decision = await decide(
    facts({title: '[Recruiting] Totally Different | #29LRRULO | TH18'}),
    deps(),
  )
  assert.ok(kinds(decision.effects).includes('report'))
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
