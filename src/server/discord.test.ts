import assert from 'node:assert/strict'
import {afterEach, beforeEach, test} from 'node:test'
import {redis, settings} from '@devvit/web/server'
import {Category} from '../shared/parse.ts'
import {createRedisFake} from '../test/redisFake.ts'
import {
  buildPayload,
  type ModEvent,
  notifyMods,
  WEBHOOK_SETTING,
} from './discord.ts'

const realFetch = globalThis.fetch
let bodies: Record<string, unknown>[] = []

function stubFetch(status = 204): void {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return {status, ok: status >= 200 && status < 300} as unknown as Response
  }) as unknown as typeof fetch
}

beforeEach(() => {
  bodies = []
  Object.assign(redis, createRedisFake())
  settings.get = (async (name: string) =>
    name === WEBHOOK_SETTING
      ? 'https://discord.com/api/webhooks/x/y'
      : undefined) as typeof settings.get
  stubFetch()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const POST = {
  id: 't3_1vxn7fs',
  title: '[Recruiting] G3’s Clan |#2YJJUVG0C | TH18 | Competitive',
  url: 'https://www.reddit.com/r/x/comments/1vxn7fs/y/',
  author: 'TubaKid44',
  category: Category.Recruiting,
}

const CLAN = {tag: '#2YJJUVG0C', name: "G3's Clan"}

test('a cooldown removal names the wait and links the previous post', () => {
  const payload = buildPayload({
    kind: 'removed',
    post: POST,
    clan: CLAN,
    reason: {
      code: 'cooldown',
      timeRemaining: '3 days, 4 hours, 12 minutes',
      previousUrl: 'https://www.reddit.com/r/x/comments/old/',
    },
  })
  const embed = (
    payload.embeds as {title: string; fields: {name: string; value: string}[]}[]
  )[0]
  assert.equal(embed?.title, 'Post removed')
  const byName = Object.fromEntries(
    (embed?.fields ?? []).map(f => [f.name, f.value]),
  )
  assert.equal(byName['May post again in'], '3 days, 4 hours, 12 minutes')
  assert.match(String(byName['Previous post']), /comments\/old/)
  assert.equal(byName['Clan tag'], '#2YJJUVG0C')
  assert.match(String(byName['Clash of Stats']), /clans\/2YJJUVG0C\/summary/)
})

test('an unknown category quotes what the user actually wrote', () => {
  const payload = buildPayload({
    kind: 'removed',
    post: POST,
    reason: {code: 'unknownCategory', raw: 'Event Recruiting'},
  })
  const embed = (payload.embeds as {description: string}[])[0]
  assert.match(String(embed?.description), /\[Event Recruiting\]/)
})

test('a bad clan tag lists every candidate that was tried', () => {
  const payload = buildPayload({
    kind: 'removed',
    post: POST,
    reason: {code: 'badClanTag', tried: ['#000', '#J0C']},
  })
  const embed = (
    payload.embeds as {fields: {name: string; value: string}[]}[]
  )[0]
  const tried = embed?.fields.find(f => f.name === 'Tags tried')
  assert.equal(tried?.value, '#000, #J0C')
})

test('a flag says plainly that nothing was removed', () => {
  const payload = buildPayload({
    kind: 'flagged',
    post: POST,
    clan: CLAN,
    reason: {code: 'prohibitedTerms', terms: ['gems', 'selling']},
  })
  const embed = (payload.embeds as {title: string; description: string}[])[0]
  assert.equal(embed?.title, 'Needs a look')
  assert.match(String(embed?.description), /\*\*Not removed\*\*/)
})

test('a clan name mismatch reads as a removal and names the clan', () => {
  const payload = buildPayload({
    kind: 'removed',
    post: POST,
    clan: CLAN,
    reason: {code: 'clanNameMismatch', clanName: 'Black Water'},
  })
  const embed = (
    payload.embeds as {
      title: string
      description: string
      fields: {name: string; value: string}[]
    }[]
  )[0]
  assert.equal(embed?.title, 'Post removed')
  assert.match(String(embed?.description), /\*\*Removed\.\*\*/)
  assert.match(String(embed?.description), /Black Water/)
  assert.equal(
    embed?.fields.find(f => f.name === 'Expected clan name')?.value,
    'Black Water',
  )
})

test('only an alert is allowed to ping the channel', () => {
  const removal = buildPayload({
    kind: 'removed',
    post: POST,
    reason: {code: 'missingCategory'},
  })
  assert.deepEqual(removal.allowed_mentions, {parse: []})
  assert.equal(removal.content, undefined)

  const alert = buildPayload({
    kind: 'alert',
    alertKey: 'coc-unauthorized',
    title: 'Clan lookups are failing',
    detail: 'HTTP 403',
  })
  assert.deepEqual(alert.allowed_mentions, {parse: ['everyone']})
  assert.match(String(alert.content), /@here/)
  assert.match(String(alert.content), /notify TubaKid via email/)
})

test('a hostile post title cannot ping the channel', () => {
  // Titles are user-controlled; parse: [] is what stops this.
  const payload = buildPayload({
    kind: 'removed',
    post: {...POST, title: '[Recruiting] @everyone join us | #2QR0QVJ29'},
    reason: {code: 'missingCategory'},
  })
  assert.deepEqual(payload.allowed_mentions, {parse: []})
})

const ALERT: ModEvent = {
  kind: 'alert',
  alertKey: 'coc-unauthorized',
  title: 'Clan lookups are failing',
  detail: 'HTTP 403 from the Clash of Clans proxy.',
}

test('an alert fires once, then stays quiet', async () => {
  assert.equal(await notifyMods(ALERT), true)
  assert.equal(await notifyMods(ALERT), false)
  assert.equal(await notifyMods(ALERT), false)
  assert.equal(bodies.length, 1, 'only the first alert reaches Discord')
})

test('throttling is per alert key', async () => {
  assert.equal(await notifyMods(ALERT), true)
  assert.equal(await notifyMods({...ALERT, alertKey: 'coc-ratelimited'}), true)
  assert.equal(bodies.length, 2)
})

test('removals are never throttled', async () => {
  const event: ModEvent = {
    kind: 'removed',
    post: POST,
    reason: {code: 'missingCategory'},
  }
  await notifyMods(event)
  await notifyMods(event)
  assert.equal(bodies.length, 2)
})

test('an unconfigured webhook is a no-op, not a crash', async () => {
  settings.get = (async () => undefined) as typeof settings.get
  assert.equal(await notifyMods(ALERT), false)
  assert.equal(bodies.length, 0)
})

test('a Discord outage never propagates to the caller', async () => {
  globalThis.fetch = (async () => {
    throw new Error('ECONNRESET')
  }) as unknown as typeof fetch
  assert.equal(await notifyMods(ALERT), false)
})

test('a non-2xx webhook response is reported, not thrown', async () => {
  stubFetch(500)
  assert.equal(await notifyMods(ALERT), false)
})

test('a very long title is truncated to fit the embed limit', () => {
  const payload = buildPayload({
    kind: 'removed',
    post: {...POST, title: 'x'.repeat(2000)},
    reason: {code: 'missingCategory'},
  })
  const embed = (
    payload.embeds as {fields: {name: string; value: string}[]}[]
  )[0]
  const title = embed?.fields.find(f => f.name === 'Title')
  assert.equal(title?.value.length, 1000)
})
