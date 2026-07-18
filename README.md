# WM31Bot

WM31Bot is a small Discord bot service. It exposes Discord interaction
webhooks for channel access controls, keeps a Discord Gateway connection open
to transform Instagram links, and runs a few configured-channel notification
jobs.

Some behavior is universal across every guild where the bot is installed; other
behavior is intentionally scoped to one configured guild and its channels.

## What it does

### Universal / cross-guild features

- Instagram link reposting across every guild where the bot is installed:
  `instagram.com` links are deleted and reposted as `kkinstagram.com` links
  through a channel webhook.
- Webhook reposts preserve the member display name and avatar where possible,
  support thread replies through the parent channel webhook, and disable
  allowed mentions to avoid duplicate pings.

### Configured-guild features

- Self-assignable Discord channel roles through localized slash commands in one
  configured guild.
- A persistent channel access panel with per-role join/leave buttons for up to
  five roles, or a select menu for larger role sets.
- Live panel member counts that refresh after component interactions and when
  the panel publisher runs.
- Daily TOEFL vocabulary posts from a checked-in Wiktionary-attributed dataset.
- A Gamer forum monitor for the Mahjong Soul gift-code thread that forwards
  new replies to Discord with the post text and first image.
- An X post monitor that forwards new posts from `@thsottiaux` to Discord using
  FxEmbed's RSS feed and Discord-friendly post links.

## Universal: Instagram link transform

When a non-bot guild member posts an `instagram.com` link, the bot deletes the
original message and reposts the transformed `kkinstagram.com` URL through a
channel webhook. The webhook payload uses the member's display name and avatar,
and disables allowed mentions so reposts do not create new pings.

Instagram link transforms run in every guild where the bot is installed. The
bot still needs channel permissions to manage messages and webhooks in each
guild/channel.

The first transformed link in a channel creates a `WM31 Instagram` webhook in
that channel. Threads are reposted through a webhook in the parent channel with
Discord's `thread_id` webhook parameter. The Gateway client heartbeats,
resumes sessions when Discord allows it, and logs clearer close reasons for
authentication or privileged-intent failures.

## Configured guild: channel access roles

All role commands and panel component interactions are guarded to one
configured guild. If a command or component interaction comes from another
guild, the bot responds with an ephemeral "指定伺服器" rejection instead of
changing roles.

The registered slash commands are `/join-wordle-channel`,
`/leave-wordle-channel`, `/join-brawlstars-channel`, and
`/leave-brawlstars-channel`. The join commands also return a member summary for
the selected role.

For one to five managed roles, the panel interleaves each role summary with
dedicated `加入` and `退出` buttons. For larger role sets, it falls back to a
Discord select menu. The panel includes localized Wordle and 荒野亂鬥 labels for
the default roles and disables allowed mentions.

Component interactions update Discord roles immediately and then refresh the
panel with the latest member counts. Slash commands remain available for the
default Wordle and 荒野亂鬥 role flows.

## Configured guild: daily TOEFL vocabulary

The bot can post one TOEFL vocabulary item per day to a configured channel. It
posts after the configured local time, defaults to `08:00` in `Asia/Taipei`,
and selects a deterministic word by date.

The target channel is validated against the configured guild before sending,
and send-state prevents duplicate posts after restarts on the same day.

Vocabulary data lives in `data/toefl-vocab.json`. The initial entries are based
on Wiktionary and every Discord message includes source and CC BY-SA 4.0
license attribution.

## Configured guild: Gamer forum monitor

The bot watches
`https://m.gamer.com.tw/forum/C.php?bsn=36476&snA=3047&to=112` for newer
article posts. On the first run it records the newest existing `post_<id>`
without sending an alert, then posts future higher post IDs to the configured
Discord channel.

The alert content includes the floor, author, post time, plain text, canonical
post link, and the first article image as a Discord embed when one exists. The
monitor follows the forum pager to the latest page, so the watched `to=112`
anchor can remain stable after the thread rolls onto a new page.

The target Discord channel is validated against the configured guild before
sending. The monitor checks new main article replies, not comments under an
existing article.

## Configured guild: X post monitor

The bot checks FxEmbed's RSS feed for `@thsottiaux` once per minute and posts
new entries to Discord channel `1527893157168283668`. Forwarded links use
`fxtwitter.com` so Discord can render the post text and media reliably.

On the first run, the monitor records the newest visible post without sending
older entries. Its state file prevents duplicate sends on later checks. The
handle, feed URL, channel, interval, and state path can all be overridden with
environment variables.

## Operator docs

- [Operations](docs/operations.md): setup, endpoints, maintenance commands,
  install permissions, and deployment.
- [Configuration](docs/configuration.md): environment variables and default
  managed-role configuration.
