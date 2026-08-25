import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import type {AddressInfo, Server} from 'node:net'
import {after, before, test} from 'node:test'
import {type Context, runWithContext} from '@devvit/web/server'
import {Endpoint, type ErrorRsp} from '../shared/api.ts'
import {onReq} from './server.ts'

let server: Server
let serverURL: string

before(async () => {
  server = createServer(async (req, rsp) => {
    await runWithContext(
      {
        appName: 'patience-bot',
        subredditName: 'PatienceBotTest',
      } as unknown as Context,
      () => onReq(req, rsp),
    )
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const info = server.address() as AddressInfo
  serverURL = `http://127.0.0.1:${info.port}`
})

after(async () => {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(err => (err ? reject(err) : resolve()))
  })
})

test('onPostCreate accepts a live-shaped trigger payload', async () => {
  const rsp = await fetch(`${serverURL}/${Endpoint.OnPostCreate}`, {
    body: JSON.stringify({
      type: 'PostCreate',
      post: {
        id: 't3_1vxm5ep',
        title:
          '[Recruiting] Black Water | #29LRRULU | TH18+ | Level 28 | War/CWL/Push',
        selftext: 'body',
        createdAt: 1787621949444,
        authorId: 't2_mfbio',
        url: '/r/PatienceBotTest/comments/1vxm5ep/x/',
        permalink: '/r/PatienceBotTest/comments/1vxm5ep/x/',
        subredditId: 't5_jgjey6',
        isSelf: true,
        isApproved: false,
        isLocked: false,
        nsfw: false,
        spam: false,
        deleted: false,
      },
      author: {
        id: 't2_mfbio',
        name: 'TubaKid44',
        karma: 8963,
        banned: false,
        suspended: false,
        spam: false,
      },
      subreddit: {id: 't5_jgjey6', name: 'PatienceBotTest'},
    }),
    headers: {'Content-Type': 'application/json'},
    method: 'POST',
  })
  assert.equal(rsp.status, 200)
  assert.equal(rsp.headers.get('Content-Type'), 'application/json')
  assert.deepEqual(await rsp.json(), {})
})

test('wrong method is 404', async () => {
  const rsp = await fetch(`${serverURL}/${Endpoint.OnPostCreate}`)
  assert.equal(rsp.status, 404)
  assert.deepEqual<ErrorRsp>(await rsp.json(), {
    error: 'not found',
    status: 404,
  })
})

test('unknown endpoint is 404', async () => {
  const rsp = await fetch(serverURL)
  assert.equal(rsp.status, 404)
  assert.deepEqual<ErrorRsp>(await rsp.json(), {
    error: 'not found',
    status: 404,
  })
})
