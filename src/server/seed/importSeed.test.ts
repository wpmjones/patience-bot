import assert from 'node:assert/strict'
import {beforeEach, test} from 'node:test'
import {redis} from '@devvit/web/server'
import {Category} from '../../shared/parse.ts'
import {createRedisFake} from '../../test/redisFake.ts'
import {
  isAuthorKnown,
  isClanKnown,
  lastTrackedPostForAuthor,
  lastTrackedPostForClan,
  postsForClanSince,
} from '../db.ts'
import {runSeed, type SeedData} from './importSeed.ts'
import type {SeedPost} from './seedData.ts'

const NOW = 1787625315000
const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  Object.assign(redis, createRedisFake())
})

function makePosts(count: number): SeedPost[] {
  return Array.from({length: count}, (_, n) => ({
    i: `p${n}`,
    t: NOW - (count - n) * 60_000,
    c: Category.Recruiting,
    g: `#CLAN${n % 3}`,
    a: `author${n % 5}`,
    k: 1 as const,
  }))
}

const SMALL: SeedData = {
  authors: ['TubaKid44', 'SomeoneElse'],
  clans: ['#29LRRULU', '#2QR0QVJ29'],
  weird: [{clanTag: '#2G2RPC8PC', name: 'x', reason: 'emojis cause trouble'}],
  posts: [
    {
      i: '1vozrde',
      t: NOW - 2 * DAY,
      c: Category.Recruiting,
      g: '#2CU2PPVJR',
      a: 'Mr_Wiggles55',
      k: 1,
    },
    {
      i: '1vxne54',
      t: NOW - 1 * DAY,
      c: Category.Searching,
      g: null,
      a: 'lordofgore-',
      k: 1,
    },
    {
      i: '1vremoved',
      t: NOW - 3 * DAY,
      c: Category.Recruiting,
      g: '#2CU2PPVJR',
      a: 'Mr_Wiggles55',
      k: 0,
    },
  ],
}

test('imports authors, clans and posts in one pass when small', async () => {
  const progress = await runSeed(SMALL)

  assert.equal(progress.done, true)
  assert.equal(progress.authorsImported, 2)
  assert.equal(progress.clansImported, 2)
  assert.equal(progress.weirdImported, 1)
  assert.equal(progress.postsImported, 3)

  assert.equal(await isAuthorKnown('tubakid44'), true)
  assert.equal(await isAuthorKnown('TUBAKID44'), true)
  assert.equal(await isClanKnown('#29LRRULU'), true)
})

test('seeded posts restore clan and author cooldowns', async () => {
  await runSeed(SMALL)
  assert.equal((await lastTrackedPostForClan('#2CU2PPVJR'))?.postId, '1vozrde')
  assert.equal(
    (await lastTrackedPostForAuthor('lordofgore-'))?.postId,
    '1vxne54',
  )
})

test('a seeded removed post counts for volume but not cooldown', async () => {
  await runSeed(SMALL)
  // The removed post is newer than the tracked one but must not be the anchor.
  assert.equal((await lastTrackedPostForClan('#2CU2PPVJR'))?.postId, '1vozrde')
  const all = await postsForClanSince('#2CU2PPVJR', 0)
  assert.equal(all.length, 2)
})

test('resumes across chunks and stops exactly once', async () => {
  const data: SeedData = {
    authors: [],
    clans: [],
    weird: [],
    posts: makePosts(250),
  }

  const first = await runSeed(data)
  assert.equal(first.postsImported, 100)
  assert.equal(first.done, false)

  const second = await runSeed(data)
  assert.equal(second.postsImported, 200)
  assert.equal(second.done, false)

  const third = await runSeed(data)
  assert.equal(third.postsImported, 250)
  assert.equal(third.done, true)

  // Running past the end is harmless and stays done.
  const fourth = await runSeed(data)
  assert.equal(fourth.postsImported, 250)
  assert.equal(fourth.done, true)
})

test('known sets are written once, not re-written on later chunks', async () => {
  const data: SeedData = {
    authors: ['a', 'b'],
    clans: ['#X'],
    weird: [],
    posts: makePosts(150),
  }

  const first = await runSeed(data)
  assert.equal(first.authorsImported, 2)
  assert.equal(first.clansImported, 1)

  const second = await runSeed(data)
  assert.equal(second.authorsImported, 0)
  assert.equal(second.clansImported, 0)
  // Still present, just not rewritten.
  assert.equal(await isAuthorKnown('a'), true)
})

test('skips posts with a category outside the rules', async () => {
  const data: SeedData = {
    authors: [],
    clans: [],
    weird: [],
    posts: [
      {i: 'bad', t: NOW, c: 'Event Recruiting', g: '#AAA', a: 'x', k: 1},
      {i: 'good', t: NOW, c: Category.Merging, g: '#BBB', a: 'y', k: 1},
    ],
  }
  const progress = await runSeed(data)
  assert.equal(progress.done, true)
  assert.equal(await lastTrackedPostForClan('#AAA'), undefined)
  assert.equal((await lastTrackedPostForClan('#BBB'))?.postId, 'good')
})
