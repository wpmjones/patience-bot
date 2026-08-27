import assert from 'node:assert/strict'
import {beforeEach, test} from 'node:test'
import {reddit, redis} from '@devvit/web/server'
import {createRedisFake} from '../test/redisFake.ts'
import {
  COOLDOWN_MS,
  lastTrackedPostForAuthor,
  lastTrackedPostForClan,
  recordPost,
} from './db.ts'
import type {ModActionEvent} from './events.ts'
import {handleModAction, resetAppUserCache} from './handleModAction.ts'

const NOW = 1787625315000
const TAG = '#29LRRULU'
const AUTHOR = 'TubaKid44'

let deleted: string[] = []

beforeEach(() => {
  Object.assign(redis, createRedisFake())
  resetAppUserCache()
  deleted = []
  reddit.getAppUser = (async () => ({
    username: 'patience-bot',
  })) as unknown as typeof reddit.getAppUser
  reddit.getCommentById = (async (id: string) => ({
    delete: async () => {
      deleted.push(id)
    },
  })) as unknown as typeof reddit.getCommentById
})

function event(overrides: Partial<ModActionEvent> = {}): ModActionEvent {
  return {
    type: 'ModAction',
    action: 'approvelink',
    moderator: {id: 't2_mod', name: 'SomeHumanMod'},
    targetPost: {id: 't3_removed'},
    ...overrides,
  }
}

async function record(
  postId: string,
  tracked: boolean,
  extra: {noticeCommentId?: string} = {},
): Promise<void> {
  await recordPost({
    postId,
    created: NOW,
    category: 'Recruiting',
    clanTag: TAG,
    author: AUTHOR,
    tracked,
    ...extra,
  })
}

const armed = {observeOnly: false}

// --- the gap this handler exists to close ---

test('approving a removed post makes it hold the clan slot', async () => {
  await record('t3_removed', false)
  assert.equal(await lastTrackedPostForClan(TAG), undefined)

  await handleModAction(event(), armed)

  const last = await lastTrackedPostForClan(TAG)
  assert.deepEqual(last, {postId: 'removed', created: NOW})
})

test('the restored cooldown runs from the post time, not the approval', async () => {
  // Approving on day five must not hand the clan a fresh six days.
  await record('t3_removed', false)
  await handleModAction(event(), armed)

  const last = await lastTrackedPostForClan(TAG)
  assert.equal(last?.created, NOW)
  assert.ok(
    (last?.created ?? 0) + COOLDOWN_MS < NOW + COOLDOWN_MS + 1,
    'cooldown is anchored to the original post',
  )
})

test('approving also restores the author cooldown', async () => {
  await record('t3_removed', false)
  await handleModAction(event(), armed)
  assert.deepEqual(await lastTrackedPostForAuthor(AUTHOR), {
    postId: 'removed',
    created: NOW,
  })
})

test('a moderator removal frees the slot the bot was holding', async () => {
  await record('t3_live', true)
  assert.ok(await lastTrackedPostForClan(TAG))

  await handleModAction(
    event({action: 'removelink', targetPost: {id: 't3_live'}}),
    armed,
  )

  assert.equal(
    await lastTrackedPostForClan(TAG),
    undefined,
    'the author can now repost a corrected title',
  )
  assert.equal(await lastTrackedPostForAuthor(AUTHOR), undefined)
})

test('removing as spam counts as a removal', async () => {
  await record('t3_live', true)
  await handleModAction(
    event({action: 'spamlink', targetPost: {id: 't3_live'}}),
    armed,
  )
  assert.equal(await lastTrackedPostForClan(TAG), undefined)
})

// --- everything the handler must not react to ---

test('the noisy majority of mod actions are ignored', async () => {
  const ignored = [
    event({action: 'removecomment', targetPost: undefined}),
    event({action: 'editflair'}),
    event({action: 'banuser', targetPost: undefined}),
    event({action: 'lock'}),
    event({action: undefined, targetPost: undefined}),
  ]
  for (const e of ignored) {
    const summary = await handleModAction(e, armed)
    assert.match(summary, /^ignored/, JSON.stringify(e.action))
  }
})

test('a post the bot never recorded is left alone', async () => {
  const summary = await handleModAction(
    event({targetPost: {id: 't3_unknown'}}),
    armed,
  )
  assert.match(summary, /unrecorded/)
})

test('approving a post that was already live changes nothing', async () => {
  await record('t3_live', true)
  const summary = await handleModAction(
    event({targetPost: {id: 't3_live'}}),
    armed,
  )
  assert.match(summary, /^no change/)
})

test("the bot's own removals are not treated as an override", async () => {
  // Reached only if the record somehow disagrees with our own action; the
  // check is what keeps the handler from reacting to itself.
  await record('t3_live', true)
  const summary = await handleModAction(
    event({
      action: 'removelink',
      moderator: {id: 't2_app', name: 'patience-bot'},
      targetPost: {id: 't3_live'},
    }),
    armed,
  )
  assert.match(summary, /by self/)
  assert.ok(await lastTrackedPostForClan(TAG), 'still tracked')
})

test('an unavailable app identity errs toward correcting the record', async () => {
  reddit.getAppUser = (async () => {
    throw new Error('no app user')
  }) as unknown as typeof reddit.getAppUser

  await record('t3_removed', false)
  await handleModAction(event(), armed)
  assert.ok(await lastTrackedPostForClan(TAG), 'the correction still landed')
})

// --- the removal comment ---

test('approving withdraws the removal comment the bot left', async () => {
  await record('t3_removed', false, {noticeCommentId: 't1_notice'})
  const summary = await handleModAction(event(), armed)

  assert.deepEqual(deleted, ['t1_notice'])
  assert.match(summary, /withdrew removal comment/)
})

test('a removal has no comment of ours to withdraw', async () => {
  await record('t3_live', true, {noticeCommentId: 't1_notice'})
  await handleModAction(
    event({action: 'removelink', targetPost: {id: 't3_live'}}),
    armed,
  )
  assert.deepEqual(deleted, [])
})

test('an already-deleted comment does not fail the correction', async () => {
  reddit.getCommentById = (async () => {
    throw new Error('404')
  }) as unknown as typeof reddit.getCommentById

  await record('t3_removed', false, {noticeCommentId: 't1_gone'})
  const summary = await handleModAction(event(), armed)

  assert.match(summary, /could not be withdrawn/)
  assert.ok(
    await lastTrackedPostForClan(TAG),
    'the tracking correction still landed',
  )
})

// --- shadow mode ---

test('observe mode works out the correction without making it', async () => {
  await record('t3_removed', false, {noticeCommentId: 't1_notice'})
  const summary = await handleModAction(event(), {observeOnly: true})

  assert.match(summary, /^\[observe\] would track/)
  assert.equal(await lastTrackedPostForClan(TAG), undefined)
  assert.deepEqual(deleted, [], 'no comment is withdrawn in a shadow run')
})
