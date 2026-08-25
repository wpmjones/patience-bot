import assert from 'node:assert/strict'
import {beforeEach, test} from 'node:test'
import {reddit} from '@devvit/web/server'
import {Category} from '../shared/parse.ts'
import {type AuthorNotice, buildNotice, sendNotice} from './authorNotice.ts'

const ALL_REMOVALS: AuthorNotice[] = [
  {kind: 'cooldown', category: Category.Recruiting, timeRemaining: '3 days'},
  {kind: 'missingCategory'},
  {kind: 'unknownCategory', raw: 'Event Recruiting'},
  {kind: 'badClanTag'},
  {kind: 'missingTownHall'},
]

test('every removal produces both a comment and a message', () => {
  for (const notice of ALL_REMOVALS) {
    const text = buildNotice(notice)
    assert.ok(text.comment, `${notice.kind} has a comment`)
    assert.ok(text.message, `${notice.kind} has a message`)
    assert.ok(text.subject, `${notice.kind} has a subject`)
  }
})

test('every removal comment points at the repliable message', () => {
  for (const notice of ALL_REMOVALS) {
    const {comment} = buildNotice(notice)
    assert.match(String(comment), /reply to that message/i, notice.kind)
    assert.match(String(comment), /not monitored/i, notice.kind)
  }
})

test('every message invites a reply instead of naming modmail', () => {
  for (const notice of ALL_REMOVALS) {
    const {message} = buildNotice(notice)
    assert.match(String(message), /reply to this message/i, notice.kind)
  }
})

test('all user-facing copy says a week, even though the code enforces six days', () => {
  // Deliberate: someone who posted last Saturday night and posts again the
  // following Saturday morning has, to them, waited a week. The looser
  // enforcement is a kindness, not a promise we make in the copy.
  const cooldown = buildNotice({
    kind: 'cooldown',
    category: Category.Recruiting,
    timeRemaining: '3 days',
  })
  assert.match(String(cooldown.comment), /this week/)
  assert.doesNotMatch(String(cooldown.comment), /six days/)
  assert.match(String(buildNotice({kind: 'welcome'}).message), /once a week/)
})

test('a repaired tag keeps the post up and only leaves a comment', () => {
  const text = buildNotice({
    kind: 'tagTypo',
    typed: '#2GQO82YVP',
    actual: '#2GQ082YVP',
    clanName: 'AK47#000',
  })
  assert.match(String(text.comment), /#2GQO82YVP/)
  assert.match(String(text.comment), /#2GQ082YVP/)
  assert.match(String(text.comment), /staying up/)
  assert.equal(text.message, undefined, 'no DM for a cosmetic correction')
  assert.equal(text.subject, undefined)
})

test('the bad tag removal blames a typo generally, not only O-for-zero', () => {
  const text = buildNotice({kind: 'badClanTag'})
  assert.match(String(text.comment), /mistyped, dropped, or added/)
  assert.match(String(text.comment), /0289PYLQGRJCUV/)
})

test('the cooldown notice states the wait in both places', () => {
  const text = buildNotice({
    kind: 'cooldown',
    category: Category.Recruiting,
    timeRemaining: '3 days, 4 hours, 12 minutes',
  })
  assert.match(String(text.comment), /3 days, 4 hours, 12 minutes/)
  assert.match(String(text.message), /3 days, 4 hours, 12 minutes/)
})

test('an unrecognised category is quoted back to the user', () => {
  const text = buildNotice({kind: 'unknownCategory', raw: 'Event Recruiting'})
  assert.match(String(text.comment), /\[Event Recruiting\]/)
  assert.match(String(text.comment), /\[Recruiting\]/)
})

test('the welcome is a message only — nothing was removed', () => {
  const text = buildNotice({kind: 'welcome'})
  assert.equal(text.comment, undefined)
  assert.match(String(text.message), /once a week/)
  assert.match(String(text.message), /reply to this message/i)
})

// --- delivery ---

let comments: {id: string; text: string}[] = []
let messages: {to: string; from: string; subject: string}[] = []
let distinguished = 0

beforeEach(() => {
  comments = []
  messages = []
  distinguished = 0
  reddit.submitComment = (async (opts: {id: string; text: string}) => {
    comments.push(opts)
    return {
      distinguish: async () => {
        distinguished++
      },
    }
  }) as unknown as typeof reddit.submitComment
  reddit.sendPrivateMessageAsSubreddit = (async (opts: {
    to: string
    fromSubredditName: string
    subject: string
  }) => {
    messages.push({
      to: opts.to,
      from: opts.fromSubredditName,
      subject: opts.subject,
    })
  }) as typeof reddit.sendPrivateMessageAsSubreddit
})

const TARGET = {
  postId: 't3_1vxn7fs',
  author: 'TubaKid44',
  subredditName: 'ClashOfClansRecruit',
}

test('a removal comments, distinguishes, and messages as the subreddit', async () => {
  const result = await sendNotice({kind: 'missingCategory'}, TARGET)

  assert.deepEqual(result, {commented: true, messaged: true})
  assert.equal(comments.length, 1)
  assert.equal(comments[0]?.id, 't3_1vxn7fs')
  assert.equal(distinguished, 1)
  assert.deepEqual(messages[0], {
    to: 'TubaKid44',
    from: 'ClashOfClansRecruit',
    subject: 'Your post was removed — title needs a category tag',
  })
})

test('a tag-typo notice comments without messaging', async () => {
  const result = await sendNotice(
    {
      kind: 'tagTypo',
      typed: '#2GQO82YVP',
      actual: '#2GQ082YVP',
      clanName: 'AK47#000',
    },
    TARGET,
  )
  assert.deepEqual(result, {commented: true, messaged: false})
  assert.equal(messages.length, 0)
})

test('the welcome sends a message and never comments', async () => {
  const result = await sendNotice({kind: 'welcome'}, TARGET)
  assert.deepEqual(result, {commented: false, messaged: true})
  assert.equal(comments.length, 0)
})

test('a blocked-DM user still gets the comment', async () => {
  reddit.sendPrivateMessageAsSubreddit = (async () => {
    throw new Error('NOT_WHITELISTED_BY_USER_MESSAGE')
  }) as typeof reddit.sendPrivateMessageAsSubreddit

  const result = await sendNotice({kind: 'badClanTag'}, TARGET)
  assert.deepEqual(result, {commented: true, messaged: false})
  assert.equal(comments.length, 1)
})

test('a failed comment does not suppress the message', async () => {
  reddit.submitComment = (async () => {
    throw new Error('THREAD_LOCKED')
  }) as unknown as typeof reddit.submitComment

  const result = await sendNotice({kind: 'badClanTag'}, TARGET)
  assert.deepEqual(result, {commented: false, messaged: true})
  assert.equal(messages.length, 1)
})

test('both failing is reported, never thrown', async () => {
  reddit.submitComment = (async () => {
    throw new Error('nope')
  }) as unknown as typeof reddit.submitComment
  reddit.sendPrivateMessageAsSubreddit = (async () => {
    throw new Error('nope')
  }) as typeof reddit.sendPrivateMessageAsSubreddit

  // The post is already removed by this point; throwing would lose the record.
  const result = await sendNotice(
    {kind: 'cooldown', category: Category.Searching, timeRemaining: '1 day'},
    TARGET,
  )
  assert.deepEqual(result, {commented: false, messaged: false})
})
