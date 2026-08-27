import assert from 'node:assert/strict'
import {beforeEach, test} from 'node:test'
import {redis} from '@devvit/web/server'
import {Category} from '../shared/parse.ts'
import {createRedisFake} from '../test/redisFake.ts'
import {
  activeClanTagsSince,
  addWeirdClan,
  authorsForClanSince,
  COOLDOWN_MS,
  getPost,
  getStats,
  getWeirdClan,
  hasSeenPost,
  isAuthorKnown,
  isClanKnown,
  isWeirdClan,
  KEY,
  lastTrackedPostForAuthor,
  lastTrackedPostForClan,
  listWeirdClans,
  markAuthorKnown,
  markClanKnown,
  postsForClanSince,
  pruneOlderThan,
  RETENTION_MS,
  recordPost,
  removeWeirdClan,
  seedPosts,
  setNoticeComment,
  setTracked,
} from './db.ts'

const NOW = 1787621949444
const DAY = 24 * 60 * 60 * 1000
const TAG = '#29LRRULU'

beforeEach(() => {
  // Swap the whole client; db.ts only ever reaches it through this import.
  Object.assign(redis, createRedisFake())
})

function post(overrides: Partial<Parameters<typeof recordPost>[0]> = {}) {
  return recordPost({
    postId: 't3_a1',
    created: NOW,
    category: Category.Recruiting,
    clanTag: TAG,
    author: 'someone',
    tracked: true,
    ...overrides,
  })
}

test('records a post and reads it back without the t3_ prefix', async () => {
  await post()
  assert.equal(await hasSeenPost('t3_a1'), true)
  assert.equal(await hasSeenPost('a1'), true)
  assert.equal(await hasSeenPost('t3_nope'), false)

  const record = await getPost('t3_a1')
  assert.equal(record?.postId, 'a1')
  assert.equal(record?.clanTag, TAG)
  assert.equal(record?.tracked, true)
})

test('gives post hashes a retention TTL so they self-clean', async () => {
  await post()
  const fake = redis as unknown as {expiries: Map<string, number>}
  assert.equal(fake.expiries.get(KEY.post('a1')), RETENTION_MS / 1000)
})

test('finds the most recent tracked post for a clan', async () => {
  await post({postId: 't3_old', created: NOW - 3 * DAY})
  await post({postId: 't3_new', created: NOW - 1 * DAY})
  const last = await lastTrackedPostForClan(TAG)
  assert.equal(last?.postId, 'new')
  assert.equal(last?.created, NOW - 1 * DAY)
})

test('an untracked post never becomes the cooldown anchor', async () => {
  await post({postId: 't3_good', created: NOW - 3 * DAY, tracked: true})
  await post({postId: 't3_removed', created: NOW - 1 * DAY, tracked: false})

  // The removed post must not extend the cooldown...
  const last = await lastTrackedPostForClan(TAG)
  assert.equal(last?.postId, 'good')

  // ...but must still count toward the repeat-offender report.
  const all = await postsForClanSince(TAG, NOW - 6 * DAY)
  assert.equal(all.length, 2)
})

test('tracks authors separately from clans', async () => {
  await post({
    postId: 't3_s1',
    category: Category.Searching,
    clanTag: undefined,
    author: 'Patrick',
  })
  const last = await lastTrackedPostForAuthor('Patrick')
  assert.equal(last?.postId, 's1')
  // Author keys are case-insensitive; Reddit usernames are not case-sensitive.
  assert.equal((await lastTrackedPostForAuthor('patrick'))?.postId, 's1')
})

test('counts only posts inside the cooldown window', async () => {
  await post({postId: 't3_a', created: NOW - 7 * DAY})
  await post({postId: 't3_b', created: NOW - 5 * DAY})
  await post({postId: 't3_c', created: NOW - 1 * DAY})

  const since = NOW - COOLDOWN_MS
  const inWindow = await postsForClanSince(TAG, since)
  assert.deepEqual(
    inWindow.map(entry => entry.postId),
    ['b', 'c'],
  )
})

test('lists distinct authors for a clan in the window', async () => {
  await post({postId: 't3_a', created: NOW - 1 * DAY, author: 'alice'})
  await post({postId: 't3_b', created: NOW - 2 * DAY, author: 'bob'})
  await post({postId: 't3_c', created: NOW - 3 * DAY, author: 'alice'})
  await post({postId: 't3_d', created: NOW - 9 * DAY, author: 'carol'})

  const authors = await authorsForClanSince(TAG, NOW - COOLDOWN_MS)
  assert.deepEqual(authors.sort(), ['alice', 'bob'])
})

test('indexes active clan tags', async () => {
  await post({postId: 't3_a', clanTag: '#AAA', created: NOW - 1 * DAY})
  await post({postId: 't3_b', clanTag: '#BBB', created: NOW - 8 * DAY})

  assert.deepEqual(await activeClanTagsSince(NOW - COOLDOWN_MS), ['#AAA'])
  assert.equal((await activeClanTagsSince(0)).length, 2)
})

test('pruning drops everything past retention and leaves the rest', async () => {
  await post({postId: 't3_stale', created: NOW - 10 * DAY})
  await post({postId: 't3_fresh', created: NOW - 1 * DAY})

  await pruneOlderThan(NOW)

  const remaining = await postsForClanSince(TAG, 0)
  assert.deepEqual(
    remaining.map(entry => entry.postId),
    ['fresh'],
  )
  assert.equal((await lastTrackedPostForClan(TAG))?.postId, 'fresh')
})

test('pruning clears the active indexes too', async () => {
  await post({
    postId: 't3_stale',
    clanTag: '#OLD',
    created: NOW - 10 * DAY,
    author: 'ghost',
  })
  await pruneOlderThan(NOW)
  assert.deepEqual(await activeClanTagsSince(0), [])
  assert.equal(await lastTrackedPostForAuthor('ghost'), undefined)
})

test('pruning is safe to run when nothing is stale', async () => {
  await post({postId: 't3_fresh', created: NOW - 1 * DAY})
  assert.equal(await pruneOlderThan(NOW), 0)
  assert.equal((await lastTrackedPostForClan(TAG))?.postId, 'fresh')
})

test('marks clans and authors known exactly once', async () => {
  assert.equal(await markClanKnown(TAG, NOW), true)
  assert.equal(await markClanKnown(TAG, NOW + 1000), false)
  assert.equal(await isClanKnown(TAG), true)
  assert.equal(await isClanKnown('#NEVER'), false)

  assert.equal(await markAuthorKnown('TubaKid44', NOW), true)
  // Reddit usernames are not case-sensitive.
  assert.equal(await markAuthorKnown('tubakid44', NOW), false)
  assert.equal(await isAuthorKnown('TUBAKID44'), true)
})

test('pruning never forgets a known clan or author', async () => {
  // The whole point of the known sets: someone posting on an eight-day rhythm
  // is legal under a six-day cooldown and must not be re-welcomed every time.
  await markClanKnown(TAG, NOW - 400 * DAY)
  await markAuthorKnown('TubaKid44', NOW - 400 * DAY)
  await post({postId: 't3_stale', created: NOW - 10 * DAY})

  await pruneOlderThan(NOW)

  assert.equal(await isClanKnown(TAG), true)
  assert.equal(await isAuthorKnown('TubaKid44'), true)
  // ...while the cooldown data for that same clan is gone.
  assert.equal(await lastTrackedPostForClan(TAG), undefined)
})

test('reports stats for the moderator menu', async () => {
  await markClanKnown('#AAA', NOW)
  await markClanKnown('#BBB', NOW)
  await markAuthorKnown('alice', NOW)
  await addWeirdClan('#AAA', {reason: 'test'})
  await post({postId: 't3_a', clanTag: '#AAA', created: NOW, author: 'alice'})

  assert.deepEqual(await getStats(), {
    knownClans: 2,
    knownAuthors: 1,
    activeClans: 1,
    activeAuthors: 1,
    weirdClans: 1,
  })
})

test('manages the weird clan list with names and reasons', async () => {
  assert.equal(await isWeirdClan(TAG), false)
  await addWeirdClan(TAG, {
    name: '\u26c5\ufe0f\u2728',
    reason: 'emojis cause trouble',
  })
  await addWeirdClan('#AAA')

  assert.equal(await isWeirdClan(TAG), true)
  assert.deepEqual(await getWeirdClan(TAG), {
    clanTag: TAG,
    name: '\u26c5\ufe0f\u2728',
    reason: 'emojis cause trouble',
  })
  assert.deepEqual(await listWeirdClans(), [
    {
      clanTag: '#29LRRULU',
      name: '\u26c5\ufe0f\u2728',
      reason: 'emojis cause trouble',
    },
    {clanTag: '#AAA'},
  ])

  await removeWeirdClan(TAG)
  assert.equal(await isWeirdClan(TAG), false)
  assert.equal(await getWeirdClan(TAG), undefined)
})

test('seeds history in bulk', async () => {
  await seedPosts([
    {
      postId: '1vxm5ep',
      created: NOW - 2 * DAY,
      category: Category.Recruiting,
      clanTag: TAG,
      author: 'TubaKid44',
      tracked: true,
    },
    {
      postId: '1vxm5eq',
      created: NOW - 1 * DAY,
      category: Category.Searching,
      author: 'TubaKid44',
      tracked: true,
    },
  ])

  assert.equal((await lastTrackedPostForClan(TAG))?.postId, '1vxm5ep')
  assert.equal((await lastTrackedPostForAuthor('TubaKid44'))?.postId, '1vxm5eq')
})

// --- moderator corrections ---

test('setTracked reports what it did without touching absent posts', async () => {
  assert.equal(await setTracked('t3_never_seen', true), 'unknown')

  await post({postId: 't3_1vxm5ep', tracked: true})
  assert.equal(await setTracked('t3_1vxm5ep', true), 'unchanged')
  assert.equal(await setTracked('t3_1vxm5ep', false), 'changed')
})

test('untracking leaves the author in the active index for the pruner', async () => {
  // activeAuthors is the only handle pruneOlderThan has on tracked:author:*
  // keys. Dropping the author here would strand the set with nothing left to
  // iterate it, so it leaks past retention forever.
  await post({postId: 't3_1vxm5ep', tracked: true})
  await setTracked('t3_1vxm5ep', false)

  assert.equal(await lastTrackedPostForAuthor('someone'), undefined)
  assert.deepEqual(await activeClanTagsSince(0), [TAG])
  assert.equal(
    (await redis.zScore(KEY.activeAuthors, 'someone')) != null,
    true,
    'still reachable by the pruner',
  )
})

test('a post survives an untrack-then-retrack round trip intact', async () => {
  await post({postId: 't3_1vxm5ep', tracked: true})
  await setTracked('t3_1vxm5ep', false)
  await setTracked('t3_1vxm5ep', true)

  const back = await getPost('t3_1vxm5ep')
  assert.equal(back?.tracked, true)
  assert.deepEqual(await lastTrackedPostForClan(TAG), {
    postId: '1vxm5ep',
    created: NOW,
  })
})

test('the notice comment id is preserved by a later record', async () => {
  // setNoticeComment runs while the removal is being executed, before the
  // record effect. hSet merges, so the record must not wipe it.
  await setNoticeComment('t3_1vxm5ep', 't1_notice')
  await post({postId: 't3_1vxm5ep', tracked: false})

  assert.equal((await getPost('t3_1vxm5ep'))?.noticeCommentId, 't1_notice')
})
