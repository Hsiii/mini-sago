# WM31Bot

WM31Bot is a small Bun service for a Discord bot. It exposes Discord
interaction webhooks for channel access slash commands, and it keeps a Discord
Gateway connection open to transform Instagram links into kkinstagram links.

## Features

- Self-assignable Discord channel roles through localized slash commands.
- A persistent channel access panel with per-role join/leave buttons for up to
  five roles, or a select menu for larger role sets.
- Live panel member counts that refresh after component interactions and when
  the panel publisher runs.
- Instagram link reposting across every guild where the bot is installed:
  `instagram.com` links are deleted and reposted as `kkinstagram.com` links
  through a channel webhook.
- Webhook reposts preserve the member display name and avatar where possible,
  support thread replies through the parent channel webhook, and disable
  allowed mentions to avoid duplicate pings.
- Daily TOEFL vocabulary posts from a checked-in Wiktionary-attributed dataset.
- A Gamer forum monitor for the Mahjong Soul gift-code thread that forwards
  new replies to Discord with the post text and first image.

## Use it

1. Install dependencies and create `.env.local`.
2. Set `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, and `DISCORD_BOT_TOKEN`.
3. Set `DISCORD_GUILD_ID` for the Wordle/荒野 role-control server, and
   optionally set `SELF_ASSIGNABLE_ROLES`.
4. Enable the Message Content privileged intent in the Discord Developer Portal
   under Bot -> Privileged Gateway Intents. Without this, Discord closes the
   Gateway connection with code `4014` and Instagram links cannot be read.
5. Sync the Discord application install settings so the bot profile
   `Add App` / `Add to Server` flow requests `applications.commands`, `bot`,
   `View Channels`, `Send Messages`, `Read Message History`, `Manage Roles`,
   `Manage Messages`, and `Manage Webhooks`.
6. Publish the slash commands.
7. Publish the channel access panel. Pass a channel ID or set
   `DISCORD_CHANNEL_ACCESS_CHANNEL_ID`.
8. Optionally set `TOEFL_VOCAB_CHANNEL_ID` to post one vocabulary item per day.
   The Gamer forum monitor defaults to channel `1518127531968958558`; override
   `GAMER_FORUM_CHANNEL_ID` only if it should post elsewhere.
9. Run locally or deploy, then point the Discord Interactions Endpoint URL at
   `/api/interactions`.

```bash
bun install
bun run sync:install
bun run register:commands
bun run publish:panel -- 1520033288767537263
bun run dev
```

## Endpoints

- `GET /api/health` returns configuration health.
- `POST /api/interactions` handles Discord slash commands and panel
  components.

## Channel access panel

`bun run publish:panel -- CHANNEL_ID` creates or updates the channel access
panel in the target channel. It recognizes existing panel messages, including
older legacy panel content, so republishing refreshes the same message instead
of posting a duplicate.

For one to five managed roles, the panel interleaves each role summary with
dedicated `加入` and `退出` buttons. For larger role sets, it falls back to a
Discord select menu. The panel is sent as Components V2, includes localized
Wordle and 荒野亂鬥 labels for the default roles, and disables allowed mentions.

Component interactions update Discord roles immediately and then refresh the
panel with the latest member counts. Slash commands remain available for the
default Wordle and 荒野亂鬥 role flows.

## Instagram link transform

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

## Discord installation permissions

Discord's bot profile `Add App` flow uses the application-level Guild Install
Default Install Settings, not this repository's README invite text. Run
`bun run sync:install` after setting `DISCORD_APPLICATION_ID` and
`DISCORD_BOT_TOKEN` to update those settings through the Discord API. In the
Developer Portal, keep Installation -> Install Link set to
`Discord Provided Link` so the profile button uses these defaults.

The synced permission bitfield is `805383168`, which includes:

- `View Channels`
- `Send Messages`
- `Manage Messages`
- `Read Message History`
- `Manage Roles`
- `Manage Webhooks`

For role assignment to work, the bot's highest role in each server must still
be above the self-assignable channel roles in Server Settings -> Roles.

## Daily TOEFL vocabulary

Set `TOEFL_VOCAB_CHANNEL_ID` to enable the daily vocabulary message. The bot
posts after `TOEFL_VOCAB_TIME` in `TOEFL_VOCAB_TIMEZONE`; both default to
`08:00` and `Asia/Taipei`. The selected word is deterministic by date, and the
state file prevents duplicate sends after restarts on the same day.

Vocabulary data lives in `data/toefl-vocab.json`. The initial entries are based
on Wiktionary and every Discord message includes Wiktionary source and
CC BY-SA 4.0 license attribution. To fetch raw Wiktionary definitions for new
words, run:

```bash
bun run fetch:vocab -- abate adapt analyze
```

Review the generated output before replacing or appending to
`data/toefl-vocab.json`; Wiktionary definitions are broad, so TOEFL-friendly
examples and Traditional Chinese explanations should stay human-reviewed.

## Gamer forum monitor

The bot watches
`https://m.gamer.com.tw/forum/C.php?bsn=36476&snA=3047&to=112` for newer
article posts. On the first run it records the newest existing `post_<id>` in
`GAMER_FORUM_STATE_FILE` without sending an alert, then posts future higher
post IDs to `GAMER_FORUM_CHANNEL_ID`.

The alert content includes the floor, author, post time, plain text, canonical
post link, and the first article image as a Discord embed when one exists. The
monitor follows the forum pager to the latest page, so the watched `to=112`
anchor can remain stable after the thread rolls onto a new page.

Set `GAMER_FORUM_MONITOR_DISABLED=true` to disable the monitor.

## Oracle Cloud Free Tier deployment

Oracle's Always Free resources include small VM shapes that are enough for this
bot. Discord interaction endpoints must be public HTTPS URLs, so run this app
behind the shared BotsProxy Caddy service that owns the domain and TLS.

You need a domain or subdomain, such as `bot.example.com`, with a DNS `A`
record pointed at the Oracle VM public IP. Discord will not accept a plain HTTP
endpoint. BotsProxy routes `/wm31/*` to this app on the shared Docker network.

1. Create an Oracle Cloud account and tenancy.
2. Create a minimal Always Free VM:
   - Image: Ubuntu 24.04 or 22.04.
   - Shape: `VM.Standard.E2.1.Micro`, or `VM.Standard.A1.Flex` if you prefer Arm.
   - Size: 1 OCPU and 1 GB RAM.
   - Boot volume: 50 GB.
   - Networking: public subnet with a public IPv4 address.
   - Ingress: TCP `22`, `80`, and `443`.
3. Point your DNS `A` record to the VM public IP.
4. SSH into the VM and install Docker.
5. Clone this repository onto the VM under the WM31 app directory.
6. Create `.env.production` from `.env.production.example` and fill in:
   - `DISCORD_APPLICATION_ID`
   - `DISCORD_PUBLIC_KEY`
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_GUILD_ID`
   - `SELF_ASSIGNABLE_ROLES`
7. Make sure the shared `bots_shared` Docker network exists. BotsProxy creates
   it, or you can create it manually:

```bash
docker network create bots_shared
```

8. Start the service:

```bash
docker compose up -d --build
docker compose logs -f
```

9. Confirm the proxied health endpoint after BotsProxy is running:

```bash
curl https://YOUR_DOMAIN/wm31/api/health
```

10. In the Discord Developer Portal, set the Interactions Endpoint URL to:

```text
https://YOUR_DOMAIN/wm31/api/interactions
```

The production Compose stack caps runtime usage so the bot remains small:

- app container: 0.25 CPU and 256 MB RAM

The Compose stack also persists the TOEFL vocab send-state in the
`wm31bot-state` volume when `TOEFL_VOCAB_STATE_FILE` is set to
`/app/state/toefl-vocab-state.json`.

## Environment variables

| Name                                | Required | Description                                                                                                                      |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_APPLICATION_ID`            | Yes      | Discord application ID                                                                                                           |
| `DISCORD_PUBLIC_KEY`                | Yes      | Public key used to verify interaction signatures                                                                                 |
| `DISCORD_BOT_TOKEN`                 | Yes      | Bot token used for Discord REST role updates                                                                                     |
| `DISCORD_GUILD_ID`                  | Yes      | Guild where Wordle/荒野 role-control interactions are allowed. Defaults to `1282936453134815275` when omitted                    |
| `DISCORD_CHANNEL_ACCESS_CHANNEL_ID` | No       | Default Discord channel ID for `bun run publish:panel`                                                                           |
| `DISCORD_GATEWAY_DISABLED`          | No       | Set to `true` to run only the HTTP endpoints without the Instagram Gateway listener                                              |
| `TOEFL_VOCAB_CHANNEL_ID`            | No       | Discord channel ID that receives the daily TOEFL vocabulary message. Leave unset to disable                                      |
| `TOEFL_VOCAB_TIME`                  | No       | Local posting time in `HH:MM` format. Defaults to `08:00`                                                                        |
| `TOEFL_VOCAB_TIMEZONE`              | No       | IANA timezone used for daily scheduling. Defaults to `Asia/Taipei`                                                               |
| `TOEFL_VOCAB_STATE_FILE`            | No       | JSON file used to avoid duplicate daily sends. Defaults to `.data/toefl-vocab-state.json`; use `/app/state/...` in Docker        |
| `GAMER_FORUM_CHANNEL_ID`            | No       | Discord channel ID that receives Gamer forum post alerts. Defaults to `1518127531968958558`                                      |
| `GAMER_FORUM_URL`                   | No       | Gamer forum thread URL to watch. Defaults to the Mahjong Soul gift-code thread `to=112` URL                                      |
| `GAMER_FORUM_CHECK_INTERVAL_MS`     | No       | Forum polling interval in milliseconds. Defaults to `60000`; minimum `10000`                                                     |
| `GAMER_FORUM_STATE_FILE`            | No       | JSON file used to avoid duplicate forum alerts. Defaults to `.data/gamer-forum-state.json`; use `/app/state/...` in Docker       |
| `GAMER_FORUM_MONITOR_DISABLED`      | No       | Set to `true` to disable the Gamer forum monitor                                                                                 |
| `SELF_ASSIGNABLE_ROLES`             | No       | JSON array of managed role configs. Defaults to the Wordle role `1451976411152781466` and Brawl Stars role `1450774352386719775` |

Default `SELF_ASSIGNABLE_ROLES` value:

```json
[
  {
    "id": "1451976411152781466",
    "label": "Wordle Channel",
    "description": "Access to the Wordle channel",
    "emoji": "🟩"
  },
  {
    "id": "1450774352386719775",
    "label": "Brawl Stars Channel",
    "description": "Access to the Brawl Stars channel",
    "emoji": "⭐"
  }
]
```
