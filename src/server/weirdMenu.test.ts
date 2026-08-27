import assert from 'node:assert/strict'
import {beforeEach, test} from 'node:test'
import {redis} from '@devvit/web/server'
import type {Form} from '@devvit/web/shared'
import {createRedisFake} from '../test/redisFake.ts'
import type {Clan} from './coc.ts'
import {addWeirdClan, isWeirdClan, listWeirdClans} from './db.ts'
import {
  exemptContextFor,
  exemptForm,
  FORM,
  formValues,
  manageForm,
  removeFieldName,
  submitExempt,
  submitManage,
} from './weirdMenu.ts'

const BLACK_WATER: Clan = {
  tag: '#29LRRULU',
  name: 'Black Water',
  level: 28,
  members: 47,
}

const TITLE = '[Recruiting] Black Water | #29LRRULU | TH18'

beforeEach(() => {
  Object.assign(redis, createRedisFake())
})

function form(rsp: {showForm?: {form: Form}}): Form {
  assert.ok(rsp.showForm, 'expected a form')
  return rsp.showForm.form
}

function field(f: Form, name: string): Record<string, unknown> {
  const found = f.fields.find(x => 'name' in x && x.name === name)
  assert.ok(found, `expected a ${name} field`)
  return found as unknown as Record<string, unknown>
}

// --- opening the form from a post ---

test('a post prefills the tag and the name from the game API', () => {
  const outcome = exemptContextFor(TITLE, {kind: 'found', clan: BLACK_WATER})
  assert.equal(outcome.kind, 'form')
  assert.deepEqual(outcome.kind === 'form' ? outcome.context : {}, {
    clanTag: '#29LRRULU',
    clanName: 'Black Water',
  })
})

test('the API name wins over whatever the title said', () => {
  // The whole point of exempting is that the title cannot show the real name.
  const outcome = exemptContextFor('[Recruiting] ⛅️✨ | #2G2RPC8PC | TH12', {
    kind: 'found',
    clan: {...BLACK_WATER, tag: '#2G2RPC8PC', name: '⛅️✨'},
  })
  assert.equal(
    outcome.kind === 'form' ? outcome.context.clanName : undefined,
    '⛅️✨',
  )
})

test('a tag that resolves to nothing is refused, not exempted', () => {
  // An exemption for a nonexistent clan can never match a post, so it would sit
  // on the list forever looking like it did something.
  const outcome = exemptContextFor(TITLE, {kind: 'notFound', tried: ['#ZZZ']})
  assert.equal(outcome.kind, 'refuse')
  assert.match(
    outcome.kind === 'refuse' ? outcome.message : '',
    /genuinely bad tag/,
  )
})

test('an API outage still lets the clan be exempted, with a warning', () => {
  const outcome = exemptContextFor(TITLE, {
    kind: 'unresolved',
    reason: {kind: 'unauthorized', message: 'HTTP 403'},
  })
  assert.equal(outcome.kind, 'form')
  assert.equal(
    outcome.kind === 'form' ? outcome.context.clanTag : '',
    '#29LRRULU',
  )
  assert.match(
    outcome.kind === 'form' ? (outcome.context.note ?? '') : '',
    /unreachable/,
  )
})

test('a title with no tag sends the moderator to the subreddit menu', () => {
  const outcome = exemptContextFor('[Recruiting] no tag here', undefined)
  assert.equal(outcome.kind, 'refuse')
  assert.match(
    outcome.kind === 'refuse' ? outcome.message : '',
    /subreddit menu/,
  )
})

test('the form opens empty from the subreddit menu', () => {
  const f = form(exemptForm())
  assert.equal(field(f, 'clanTag').defaultValue, '')
  assert.equal(field(f, 'reason').required, true)
})

test('a reason is always required, even when everything else is prefilled', () => {
  // A bare tag on the list is not reviewable a year later.
  const f = form(exemptForm({clanTag: '#29LRRULU', clanName: 'Black Water'}))
  assert.equal(field(f, 'clanTag').defaultValue, '#29LRRULU')
  assert.equal(field(f, 'reason').required, true)
})

// --- saving ---

test('exempting a clan takes it out of the name check', async () => {
  assert.equal(await isWeirdClan('#2G2RPC8PC'), false)

  const rsp = await submitExempt({
    clanTag: '#2G2RPC8PC',
    clanName: '⛅️✨',
    reason: 'emojis cause trouble',
  })

  assert.equal(await isWeirdClan('#2G2RPC8PC'), true)
  assert.match(
    String(rsp.showToast && (rsp.showToast as {text: string}).text),
    /exempt/,
  )
  assert.deepEqual(await listWeirdClans(), [
    {clanTag: '#2G2RPC8PC', name: '⛅️✨', reason: 'emojis cause trouble'},
  ])
})

test('a tag typed with a letter O still matches posts', async () => {
  // Stored raw, weird.json's own #2GQO82YVP could never match a parsed tag,
  // so the exemption would silently do nothing.
  await submitExempt({clanTag: '#2GQO82YVP', reason: 'clan name has hashtag'})
  assert.equal(await isWeirdClan('#2GQ082YVP'), true)
})

test('a blank tag is refused rather than written', async () => {
  const rsp = await submitExempt({clanTag: '   ', reason: 'x'})
  assert.match(
    String(rsp.showToast && (rsp.showToast as {text: string}).text),
    /required/,
  )
  assert.deepEqual(await listWeirdClans(), [])
})

test('junk in the tag field does not become an entry', async () => {
  const rsp = await submitExempt({clanTag: '#!', reason: 'x'})
  assert.match(
    String(rsp.showToast && (rsp.showToast as {text: string}).text),
    /not a clan tag/,
  )
  assert.deepEqual(await listWeirdClans(), [])
})

// --- reviewing and removing ---

test('an empty list says so instead of opening a form', async () => {
  const rsp = manageForm(await listWeirdClans())
  assert.equal(rsp.showForm, undefined)
  assert.match(
    String(rsp.showToast && (rsp.showToast as {text: string}).text),
    /No clans are exempt/,
  )
})

test('each clan gets its own row rather than one block of text', async () => {
  // Reddit renders a form description as a single run of plain text, so the
  // newlines in a joined listing collapse and ten entries arrive as one
  // paragraph. One field per entry is what puts them on separate lines.
  await addWeirdClan('#2G2RPC8PC', {name: '⛅️✨', reason: 'emojis'})
  await addWeirdClan('#2R2CUJLPG', {name: 'Blank name', reason: 'only spaces'})

  const f = form(manageForm(await listWeirdClans()))
  assert.equal(f.fields.length, 2)
  assert.doesNotMatch(String(f.description), /2G2RPC8PC/)
  assert.match(String(f.title), /2 clans/)

  const first = field(f, removeFieldName('#2G2RPC8PC'))
  assert.equal(first.type, 'boolean')
  assert.equal(first.label, '#2G2RPC8PC — ⛅️✨')
  assert.equal(first.helpText, 'emojis', 'the reason explains its own row')
  assert.equal(first.defaultValue, false, 'nothing is pre-selected')
})

test('an entry with no name or reason still reads sensibly', async () => {
  await addWeirdClan('#2G2RPC8PC')
  const f = form(manageForm(await listWeirdClans()))
  const only = field(f, removeFieldName('#2G2RPC8PC'))
  assert.equal(only.label, '#2G2RPC8PC — (no name recorded)')
  assert.equal(only.helpText, 'No reason recorded.')
})

test('switching a clan on puts it back under the name check', async () => {
  await addWeirdClan('#2G2RPC8PC', {reason: 'emojis'})
  await addWeirdClan('#2R2CUJLPG', {reason: 'only spaces'})

  const rsp = await submitManage({
    [removeFieldName('#2G2RPC8PC')]: true,
    [removeFieldName('#2R2CUJLPG')]: false,
  })

  assert.equal(await isWeirdClan('#2G2RPC8PC'), false)
  assert.equal(await isWeirdClan('#2R2CUJLPG'), true, 'the other is untouched')
  assert.match(
    String(rsp.showToast && (rsp.showToast as {text: string}).text),
    /1 clan still exempt/,
  )
})

test('every switch left off removes nothing', async () => {
  await addWeirdClan('#2G2RPC8PC', {reason: 'emojis'})
  await submitManage({[removeFieldName('#2G2RPC8PC')]: false})
  assert.equal(await isWeirdClan('#2G2RPC8PC'), true)
})

test('the field name round-trips the tag it carries', () => {
  // A boolean carries no value of its own, so the tag rides in the key.
  assert.equal(removeFieldName('#2G2RPC8PC'), 'remove_2G2RPC8PC')
})

test('unrelated fields are never mistaken for a removal', async () => {
  await addWeirdClan('#2G2RPC8PC', {reason: 'emojis'})
  await submitManage({
    removeEverything: true,
    remove_: true,
    other: '#2G2RPC8PC',
  })
  assert.equal(await isWeirdClan('#2G2RPC8PC'), true)
})

// --- shape tolerance ---

test('form values are read whether or not Reddit wraps them', () => {
  assert.deepEqual(formValues({clanTag: '#A'}), {clanTag: '#A'})
  assert.deepEqual(formValues({values: {clanTag: '#A'}}), {clanTag: '#A'})
  assert.deepEqual(formValues(undefined), {})
})

test('the form names match the ones declared in devvit.json', () => {
  assert.equal(exemptForm().showForm?.name, FORM.exempt)
  assert.equal(FORM.exempt, 'exemptClan')
  assert.equal(FORM.manage, 'weirdClans')
})
