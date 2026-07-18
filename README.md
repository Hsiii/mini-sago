# MiniSago

<img src="assets/minisago.png" alt="MiniSago icon" width="160">

**迷你西米露 - a tiny personal Discord bot that follows you everywhere.**

MiniSago keeps shared Discord spaces easier to use. It manages optional channel
access, improves Instagram embeds, and delivers selected community updates.

## Features

- Replies to Instagram links with only their `kkinstagram.com` URLs for reliable
  Discord embeds. The original message stays in place; MiniSago does not delete
  messages, impersonate users, or create webhooks.
- Lets members join or leave configured channels from a persistent access panel.
- Provides slash commands for the default Wordle and Brawl Stars channels.
- Posts a daily TOEFL vocabulary item when enabled.
- Forwards configured Gamer forum and X updates without replaying old posts.

## Commands

| Command                     | Action                        |
| --------------------------- | ----------------------------- |
| `/join-wordle-channel`      | Join the Wordle channel       |
| `/leave-wordle-channel`     | Leave the Wordle channel      |
| `/join-brawlstars-channel`  | Join the Brawl Stars channel  |
| `/leave-brawlstars-channel` | Leave the Brawl Stars channel |

The channel access panel provides the same join and leave actions without slash
commands. Features that target a configured server are unavailable elsewhere.

## Server Setup

MiniSago needs the `bot` and `applications.commands` scopes. Its configured
permissions are:

- View Channels
- Send Messages
- Read Message History
- Manage Roles

Place MiniSago's role above every role it should assign. Enable Discord's Message
Content privileged intent to use Instagram link replies. MiniSago does not need
the Manage Messages or Manage Webhooks permissions.

Run only one Gateway-enabled MiniSago instance per bot token. If production is
already running, set `DISCORD_GATEWAY_DISABLED=true` for local development to
prevent duplicate Instagram replies.

## Development

Requires [Bun](https://bun.sh/).

```bash
bun install
bun run dev
bun test
```

See [Configuration](docs/configuration.md) for environment variables and
[Operations](docs/operations.md) for Discord registration, panel publishing,
health checks, and deployment.
