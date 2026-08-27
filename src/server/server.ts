import {once} from 'node:events'
import type {IncomingMessage, ServerResponse} from 'node:http'
import {reddit} from '@devvit/web/server'
import type {
  MenuItemRequest,
  PartialJsonValue,
  T3,
  TriggerResponse,
  UiResponse,
} from '@devvit/web/shared'
import {Endpoint, EndpointMethod, type ErrorRsp} from '../shared/api.ts'
import {extractClanTagCandidates} from '../shared/parse.ts'
import {resolveClan} from './coc.ts'
import {getStats, listWeirdClans} from './db.ts'
import type {ModActionEvent, PostCreateEvent} from './events.ts'
import {handleModAction} from './handleModAction.ts'
import {handlePostCreate} from './handlePost.ts'
import {runSeed} from './seed/importSeed.ts'
import {
  SEED_AUTHORS,
  SEED_CLANS,
  SEED_POSTS,
  SEED_WEIRD,
} from './seed/seedData.ts'
import {
  exemptContextFor,
  exemptForm,
  manageForm,
  submitExempt,
  submitManage,
} from './weirdMenu.ts'

type AnyRsp = TriggerResponse | UiResponse | ErrorRsp

export async function onReq(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  try {
    await route(reqMsg, rspMsg)
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`
    console.error(msg)
    writeJson<ErrorRsp>(500, {error: msg, status: 500}, rspMsg)
  }
}

async function route(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  const endpoint = reqMsg.url?.slice(1) as Endpoint
  const method = EndpointMethod[endpoint]

  let rsp: AnyRsp
  if (method !== reqMsg.method) {
    rsp = {error: 'not found', status: 404}
  } else {
    switch (endpoint) {
      case Endpoint.OnPostCreate:
        rsp = await routePostCreate(reqMsg)
        break
      case Endpoint.OnModAction:
        rsp = await routeModAction(reqMsg)
        break
      case Endpoint.OnMenuStats:
        rsp = await routeStats()
        break
      case Endpoint.OnMenuExemptClan:
        rsp = await routeExemptMenu(reqMsg)
        break
      case Endpoint.OnFormExemptClan:
        rsp = await submitExempt(await readJson<unknown>(reqMsg))
        break
      case Endpoint.OnMenuWeirdClans:
        rsp = manageForm(await listWeirdClans())
        break
      case Endpoint.OnFormWeirdClans:
        rsp = await submitManage(await readJson<unknown>(reqMsg))
        break
      case Endpoint.OnMenuImportSeed:
        rsp = await routeImportSeed()
        break
      default:
        endpoint satisfies never
        rsp = {error: 'not found', status: 404}
        break
    }
  }

  writeJson<PartialJsonValue>('status' in rsp ? rsp.status : 200, rsp, rspMsg)
}

/**
 * ARMED: posts are really removed and reported, and authors really receive the
 * comment and the private message.
 *
 * Set this back to `true` for a shadow run — every rule still evaluates and
 * Discord still reports what would have happened, but nothing on the subreddit
 * is touched and nobody is contacted. Log lines are prefixed `[observe]` in
 * that mode, so the log always says which one is in force.
 */
const OBSERVE_ONLY = false

async function routePostCreate(
  reqMsg: IncomingMessage,
): Promise<TriggerResponse> {
  const event = await readJson<PostCreateEvent>(reqMsg)

  const summary = await handlePostCreate(event, {
    observeOnly: OBSERVE_ONLY,
    now: Date.now(),
  })

  console.log(
    `[onPostCreate] ${event.post.id} ${summary} :: ${event.post.title}`,
  )
  return {}
}

/**
 * Moderator overrides. Noisy by nature — Reddit sends one of these for every
 * action on the subreddit — so only the events that changed something are
 * logged.
 */
async function routeModAction(
  reqMsg: IncomingMessage,
): Promise<TriggerResponse> {
  const event = await readJson<ModActionEvent>(reqMsg)
  const summary = await handleModAction(event, {observeOnly: OBSERVE_ONLY})

  if (!summary.startsWith('ignored') && !summary.startsWith('no change')) {
    console.log(`[onModAction] ${event.targetPost?.id ?? '-'} ${summary}`)
  }
  return {}
}

/**
 * Opens the exempt-a-clan form.
 *
 * From a post it arrives prefilled: the tag comes out of the title and the
 * name out of the game API, so the moderator only supplies the reason. From
 * the subreddit menu there is no post to read, so it opens empty.
 */
async function routeExemptMenu(reqMsg: IncomingMessage): Promise<UiResponse> {
  const {location, targetId} = await readJson<MenuItemRequest>(reqMsg)
  if (location !== 'post') return exemptForm()

  let title = ''
  try {
    title = (await reddit.getPostById(targetId as T3)).title
  } catch (err) {
    console.error(`[exempt] could not read ${targetId}; ${errText(err)}`)
    return exemptForm()
  }

  const candidates = extractClanTagCandidates(title)
  // Only worth an API call if the title has something tag-shaped in it.
  const resolution =
    candidates.length > 0 ? await resolveClan(candidates) : undefined

  const outcome = exemptContextFor(title, resolution)
  return outcome.kind === 'refuse'
    ? {showToast: {text: outcome.message, appearance: 'neutral'}}
    : exemptForm(outcome.context)
}

/**
 * What the bot currently knows. Doubles as the check that a seed import landed:
 * the counts should match the export before any live traffic arrives.
 */
async function routeStats(): Promise<UiResponse> {
  const stats = await getStats()
  const n = (value: number): string => value.toLocaleString('en-US')

  console.log(`[stats] ${JSON.stringify(stats)}`)
  return {
    showToast: {
      text:
        `Tracking ${n(stats.knownClans)} clans and ${n(stats.knownAuthors)} redditors. ` +
        `Active this week: ${n(stats.activeClans)} clans, ${n(stats.activeAuthors)} redditors. ` +
        `${n(stats.weirdClans)} clans exempt from the name check.`,
      appearance: 'success',
    },
  }
}

/**
 * Temporary: imports the Python bot's history one chunk at a time. Moderators
 * run this repeatedly until it reports complete, then src/server/seed/ gets
 * deleted and the app redeployed without the seed payload.
 */
async function routeImportSeed(): Promise<UiResponse> {
  const progress = await runSeed({
    authors: SEED_AUTHORS.split('\n'),
    clans: SEED_CLANS.split('\n'),
    weird: SEED_WEIRD,
    posts: SEED_POSTS,
  })

  const text = progress.done
    ? `Seed complete — ${progress.postsImported} posts imported.`
    : `Imported ${progress.postsImported} of ${progress.totalPosts} posts. Run again to continue.`

  console.log(`[importSeed] ${JSON.stringify(progress)}`)
  return {showToast: {text, appearance: progress.done ? 'success' : 'neutral'}}
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function readJson<T>(reqMsg: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = []
  reqMsg.on('data', chunk => chunks.push(chunk))
  await once(reqMsg, 'end')
  return JSON.parse(`${Buffer.concat(chunks)}`)
}

function writeJson<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json)
  const len = Buffer.byteLength(body)
  rsp.writeHead(status, {
    'Content-Length': len,
    'Content-Type': 'application/json',
  })
  rsp.end(body)
}
