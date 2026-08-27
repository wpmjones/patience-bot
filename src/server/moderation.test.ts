import assert from 'node:assert/strict'
import {beforeEach, test} from 'node:test'
import {reddit} from '@devvit/web/server'
import {removePost, reportPost} from './moderation.ts'

let fetched: string[] = []
let reports: {postId: string; reason: string}[] = []
let removals: {id: string; isSpam: boolean}[] = []

beforeEach(() => {
  fetched = []
  reports = []
  removals = []

  reddit.getPostById = (async (id: string) => {
    fetched.push(id)
    return {id}
  }) as unknown as typeof reddit.getPostById

  reddit.report = (async (thing: {id: string}, options: {reason: string}) => {
    reports.push({postId: thing.id, reason: options.reason})
    return {}
  }) as unknown as typeof reddit.report

  reddit.remove = (async (id: string, isSpam: boolean) => {
    removals.push({id, isSpam})
  }) as typeof reddit.remove
})

test('reporting fetches the post and files a reason', async () => {
  const ok = await reportPost('t3_1vxn7fs', 'Clan name not found in title')

  assert.equal(ok, true)
  assert.deepEqual(fetched, ['t3_1vxn7fs'])
  assert.deepEqual(reports, [
    {postId: 't3_1vxn7fs', reason: 'Clan name not found in title'},
  ])
})

test('an over-long reason is truncated rather than rejected', async () => {
  await reportPost('t3_a', 'x'.repeat(300))
  assert.equal(reports[0]?.reason.length, 100)
})

test('reporting never removes the post', async () => {
  await reportPost('t3_a', 'reason')
  assert.equal(removals.length, 0, 'a reported post stays visible')
})

test('a failed report is reported back, not thrown', async () => {
  reddit.getPostById = (async () => {
    throw new Error('404')
  }) as unknown as typeof reddit.getPostById

  assert.equal(await reportPost('t3_gone', 'reason'), false)
})

test('removal is never flagged as spam', async () => {
  const ok = await removePost('t3_1vxn7fs')

  assert.equal(ok, true)
  assert.deepEqual(removals, [{id: 't3_1vxn7fs', isSpam: false}])
})

test('a failed removal is reported back, not thrown', async () => {
  reddit.remove = (async () => {
    throw new Error('FORBIDDEN')
  }) as typeof reddit.remove

  assert.equal(await removePost('t3_a'), false)
})
