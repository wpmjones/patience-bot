# Privacy Policy — Patience Bot

**Last updated:** August 27, 2026

## Who operates Patience Bot

Patience Bot is a moderation app operated by the moderator team of
[r/ClashOfClansRecruit](https://www.reddit.com/r/ClashOfClansRecruit). It runs
on Reddit's Developer Platform (Devvit), on infrastructure provided by Reddit.
The moderators do not run a server of their own for it.

It is installed only on subreddits whose moderators have chosen to install it,
and it only ever sees activity in those subreddits.

## What it does

Patience Bot enforces the posting rules of the subreddit it is installed on. It
checks that a post title follows the required format, confirms that the clan tag
in the title belongs to a real clan whose name matches, and enforces the limit
of one recruiting post per clan per week. When a post breaks a rule, the bot
removes it and tells the author why.

## What information it processes

When someone submits a post to a subreddit where Patience Bot is installed, the
bot receives:

- the Reddit username of the person who posted
- the post's ID, title, body text, link, and the time it was created
- the clan tag and clan name it reads out of the title

That is the complete list.

Patience Bot does **not** receive or process email addresses, IP addresses,
passwords, payment details, your private messages, your comments, your votes,
your browsing activity, or anything you do outside the subreddit where it is
installed. It processes nothing at all about people who do not post.

## What it stores, and for how long

Everything the bot stores lives in a Redis database provided by Reddit as part
of the Devvit platform. None of it is copied to any system operated by the
moderators.

**Kept for seven days, then deleted automatically:**

- the post's ID and creation time
- which category the post used (Recruiting, Searching, or Merging)
- the clan tag
- the author's Reddit username
- whether the post counted toward the weekly limit
- the ID of any comment the bot left on the post

**Post titles and post body text are not stored.** They are read to apply the
rules and then discarded. The bot keeps the decision, not the text.

**Kept indefinitely:**

- the list of clan tags the bot has seen
- the list of author usernames the bot has seen — kept so that first-time
  posters receive a welcome message once, and are not greeted as newcomers
  every time they post
- the list of clans exempted from the clan-name check, which moderators
  maintain, including each clan's tag, name, and the reason for the exemption

The indefinite lists hold nothing beyond a username or a clan tag. They record
that the bot has seen you before, not anything about what you posted.

## What is shared outside Reddit

**The Clash of Clans API, reached through the RoyaleAPI proxy
(`cocproxy.royaleapi.dev`).** The bot sends the clan tag, and nothing else, to
confirm the clan exists and to read back its name. No Reddit username, no post,
and no other information about you is sent. This is governed by Supercell's and
RoyaleAPI's own terms and privacy policies.

**Discord.** A private channel visible only to the subreddit's moderators
receives a notification for each action the bot takes. Those notifications
include the post title, a link to the post, the author's Reddit username, the
clan tag and name, and the reason for the action. This is governed by Discord's
privacy policy.

Patience Bot does not sell or rent information to anyone. It shows no
advertising, runs no analytics or tracking, and shares information with no other
third party.

## Messages you may receive

When the bot removes a post, it leaves a comment on the post explaining why, and
sends a private message from the subreddit with the same explanation. First-time
posters also receive a short welcome message.

Replies to those private messages go to the subreddit's moderator mail, where
the moderator team can read and answer them. Replies to the bot's comments are
not monitored.

## Who can see this information

The moderators of the subreddit where the bot is installed, and Reddit, which
hosts the app and its database. Nobody else.

Most of what the bot handles was already public: the posts themselves are
visible to anyone who visits the subreddit.

## Your choices

To ask what the bot holds about you, or to have your username removed from the
lists it retains indefinitely, send a message to the moderators of the
subreddit. For r/ClashOfClansRecruit, that is
[modmail](https://www.reddit.com/message/compose?to=/r/ClashOfClansRecruit).

The seven-day records expire on their own and need no request.

If you delete your Reddit account, your username stops identifying you, but it
may remain in the retained lists until removed on request.

## Children

Patience Bot is available only through Reddit and is subject to Reddit's own age
requirements. It does not knowingly process information about anyone below those
requirements, and it does not ask for age or any other personal detail.

## Changes to this policy

Changes will be published on this page with a new "last updated" date.

## Contact

Message the moderators of
[r/ClashOfClansRecruit](https://www.reddit.com/message/compose?to=/r/ClashOfClansRecruit).
