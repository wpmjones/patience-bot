import {once} from 'node:events'
import type {IncomingMessage, ServerResponse} from 'node:http'
import type {
  PartialJsonValue,
  TriggerResponse,
  UiResponse,
} from '@devvit/web/shared'
import {Endpoint, EndpointMethod, type ErrorRsp} from '../shared/api.ts'
import {
  absoluteUrl,
  extractClanTagCandidates,
  parseCategory,
} from '../shared/parse.ts'
import {getStats} from './db.ts'
import type {PostCreateEvent} from './events.ts'
import {runSeed} from './seed/importSeed.ts'
import {
  SEED_AUTHORS,
  SEED_CLANS,
  SEED_POSTS,
  SEED_WEIRD,
} from './seed/seedData.ts'

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
      case Endpoint.OnMenuStats:
        rsp = await routeStats()
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
 * Observe-only. Parses the title and logs what it found — no Redis writes, no
 * removals, no messages. The point is to check the parsers against live traffic
 * before anything is allowed to act on them.
 */
async function routePostCreate(
  reqMsg: IncomingMessage,
): Promise<TriggerResponse> {
  const {post, author} = await readJson<PostCreateEvent>(reqMsg)

  const category = parseCategory(post.title)
  const clanTags = extractClanTagCandidates(post.title)

  console.log(
    `[onPostCreate] ${JSON.stringify({
      postId: post.id,
      author: author?.name ?? '[deleted]',
      created: new Date(post.createdAt).toISOString(),
      title: post.title,
      category,
      clanTags,
      url: absoluteUrl(post.permalink),
    })}`,
  )

  return {}
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
