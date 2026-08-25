# Patience Bot

A moderation app for [r/ClashOfClansRecruit](https://www.reddit.com/r/ClashOfClansRecruit/).

The subreddit allows one recruitment post per clan, and one search post per
person, every six days. Patience Bot enforces that cooldown, validates that post
titles follow the subreddit's required format, verifies clan tags against the
Clash of Clans game API, and reports what it does to the moderator team.

It replaces a Python/PRAW bot that ran on a cron job outside Reddit.

## What it does

- Reads every new post via the `onPostCreate` trigger.
- Requires the title to start with `[Recruiting]`, `[Searching]`, or `[Merging]`.
- For `[Recruiting]` and `[Merging]`: verifies the clan tag resolves to a real
  clan and that the clan's name appears in the title. Tracks the cooldown per
  clan tag.
- For `[Searching]`: verifies a Town Hall level is present. Tracks the cooldown
  per post author.
- Removes posts that break the cooldown or the title format, leaving a comment
  explaining when the user may post again.
- Notifies moderators in Discord, including a daily summary of clans posting
  unusually often.

Post history is kept in Redis and pruned after seven days — the longest lookback
the bot performs is the six-day cooldown.

## Fetch Domains

This app makes outbound HTTPS requests to exactly two domains.

### `cocproxy.royaleapi.dev`

Used to read clan data from Supercell's official Clash of Clans API, so the bot
can confirm that a clan tag in a post title corresponds to a real clan and
retrieve that clan's name. Only the read-only clan endpoint
(`GET /v1/clans/{clanTag}`) is called. Nothing is written, and no Reddit user
data is sent — the request contains only the public clan tag taken from the post
title.

The official API host (`api.clashofclans.com`) cannot be used directly.
Supercell issues API keys that are bound to a fixed list of source IP addresses,
and rejects requests arriving from any other address. Devvit apps execute on
Reddit's infrastructure with egress addresses that are neither static nor known
to the developer, so an IP-bound key can never be issued for them.

[RoyaleAPI](https://docs.royaleapi.com/proxy.html) operates a long-standing
community proxy for exactly this situation, presenting a single documented
static IP (`45.79.218.79`) that developers allowlist on the Supercell developer
portal. It forwards requests unchanged to the official API. It is the standard
solution for hosts without a static IP and is widely used across the Clash of
Clans developer community.

### `discord.com`

Used to post moderation notifications to the subreddit moderator team's private
Discord server via an incoming webhook. This is outbound-only: the app sends a
message and reads nothing back. Payloads contain the post title, permalink, clan
tag, and category — all public information already visible on the post — plus
the bot's own decision about it. The moderator team has used Discord for
notifications for several years and this preserves an existing workflow.

## Commands

- `npm run playtest [r/sub]` — watch, build, upload, and install on Reddit.
- `npm run build` — build the server bundle, including the esbuild metafile.
- `npm run clean` — remove build outputs.
- `npm run test` — types, lints, unit tests, and build.
- `npm run format` — fix lints and formatting.
- `npm run lint` — check lints and formatting.
- `npm run publish` — clean, build, upload, and file an app review request.

## Development notes

Requires Node 24 or newer (see `engines` in `package.json`).

There is no client half — this app has no post UI, only trigger handlers,
scheduled jobs, and moderator menu actions. Opening the app in a browser is
expected to show nothing.

Title parsing lives in `src/shared/parse.ts` and is covered by unit tests. A bug
there removes legitimate posts, so changes to it should come with test cases.
