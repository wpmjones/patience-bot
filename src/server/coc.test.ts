import assert from 'node:assert/strict'
import {afterEach, beforeEach, test} from 'node:test'
import {settings} from '@devvit/web/server'
import {lookupClan, resolveClan, TOKEN_SETTING} from './coc.ts'

const realFetch = globalThis.fetch
let calls: string[] = []

/** Queue one response per expected call, in order. */
function stubFetch(
  responses: readonly ({status: number; body?: unknown} | {throws: string})[],
): void {
  let n = 0
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url))
    const next = responses[n++]
    if (next == null) throw new Error(`unexpected fetch call ${n}: ${url}`)
    if ('throws' in next) throw new Error(next.throws)
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      json: async () => {
        if (next.body === undefined) throw new Error('not json')
        return next.body
      },
    } as unknown as Response
  }) as typeof fetch
}

beforeEach(() => {
  calls = []
  settings.get = (async (name: string) =>
    name === TOKEN_SETTING ? 'test-token' : undefined) as typeof settings.get
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const BLACK_WATER = {
  tag: '#29LRRULU',
  name: 'Black Water',
  clanLevel: 28,
  members: 47,
}

test('resolves a clan and maps only the fields we use', async () => {
  stubFetch([{status: 200, body: BLACK_WATER}])
  assert.deepEqual(await lookupClan('#29LRRULU'), {
    kind: 'found',
    clan: {tag: '#29LRRULU', name: 'Black Water', level: 28, members: 47},
  })
})

test('url-encodes the # and goes through the proxy host', async () => {
  stubFetch([{status: 200, body: BLACK_WATER}])
  await lookupClan('#29LRRULU')
  assert.equal(calls[0], 'https://cocproxy.royaleapi.dev/v1/clans/%2329LRRULU')
})

test('404 is the bad-tag signal', async () => {
  stubFetch([{status: 404, body: {reason: 'notFound'}}])
  assert.deepEqual(await lookupClan('#BADTAG'), {kind: 'notFound'})
})

test('403 is unauthorized, never a bad tag', async () => {
  // This is what an un-allow-listed proxy IP looks like. Treating it as a bad
  // tag would remove every recruiting post on the subreddit.
  stubFetch([{status: 403, body: {reason: 'accessDenied'}}])
  assert.deepEqual(await lookupClan('#29LRRULU'), {
    kind: 'unauthorized',
    message: 'HTTP 403',
  })
})

test('429 and 5xx are distinguishable failures', async () => {
  stubFetch([{status: 429}, {status: 503}])
  assert.deepEqual(await lookupClan('#A'), {kind: 'rateLimited'})
  assert.deepEqual(await lookupClan('#A'), {kind: 'error', message: 'HTTP 503'})
})

test('a network failure is an error, not a bad tag', async () => {
  stubFetch([{throws: 'socket hang up'}])
  assert.deepEqual(await lookupClan('#29LRRULU'), {
    kind: 'error',
    message: 'socket hang up',
  })
})

test('a missing token fails closed', async () => {
  settings.get = (async () => undefined) as typeof settings.get
  const result = await lookupClan('#29LRRULU')
  assert.equal(result.kind, 'unauthorized')
  assert.equal(calls.length, 0, 'must not call the API without a token')
})

test('an unexpected body shape is an error', async () => {
  stubFetch([{status: 200, body: {unexpected: true}}])
  assert.deepEqual(await lookupClan('#29LRRULU'), {
    kind: 'error',
    message: 'unexpected response shape',
  })
})

test('resolveClan skips a decoy tag and finds the real one', async () => {
  // "[Recruiting] AK47#000 | #2GQ082YVP" — #000 is part of the clan's name.
  stubFetch([{status: 404}, {status: 200, body: BLACK_WATER}])
  const result = await resolveClan(['#000', '#2GQ082YVP'])
  assert.equal(result.kind, 'found')
  assert.equal(calls.length, 2)
})

test('resolveClan stops at the first candidate that resolves', async () => {
  stubFetch([{status: 200, body: BLACK_WATER}])
  await resolveClan(['#29LRRULU', '#SHOULDNOTBEFETCHED'])
  assert.equal(calls.length, 1)
})

test('resolveClan reports notFound only when every candidate 404s', async () => {
  stubFetch([{status: 404}, {status: 404}])
  assert.deepEqual(await resolveClan(['#AAA', '#BBB']), {
    kind: 'notFound',
    tried: ['#AAA', '#BBB'],
  })
})

test('resolveClan bails out on a non-404 rather than blaming the tag', async () => {
  stubFetch([{status: 404}, {status: 403}])
  const result = await resolveClan(['#AAA', '#BBB'])
  assert.equal(result.kind, 'unresolved')
  assert.equal(
    result.kind === 'unresolved' ? result.reason.kind : null,
    'unauthorized',
  )
})

test('no candidates means notFound without any API call', async () => {
  stubFetch([])
  assert.deepEqual(await resolveClan([]), {kind: 'notFound', tried: []})
  assert.equal(calls.length, 0)
})
