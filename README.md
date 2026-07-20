# MiniSago

<img src="assets/minisago.png" alt="MiniSago icon" width="160">

**迷你西米露 - a tiny personal Discord bot that follows you everywhere.**

MiniSago keeps shared Discord spaces easier to use. It manages optional channel
access, improves Instagram embeds, and delivers selected community updates.

## Feature scope

MiniSago is portable, but not every feature is intended for every server:

| Feature                         | Scope                         | Intent                                                                                                                         |
| ------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Instagram link replies          | Universal                     | Works in every installed server and visible channel. Leaves the original message and replies with only `kkinstagram.com` URLs. |
| Channel access panel            | Configured guild only         | Manages deployment-specific opt-in roles. The current defaults are the WM31 Wordle and Brawl Stars channel roles.              |
| Wordle/Brawl Stars commands     | WM31 configured guild only    | Convenience commands for that server's existing channels; they are not a general cross-server feature.                         |
| TOEFL vocabulary                | Configured guild and channel  | Posts one daily item only when a target channel is configured.                                                                 |
| Gamer forum and X post monitors | Configured guild and channel  | Delivers this deployment's selected feeds without replaying old posts.                                                         |
| GitHub PR review threads        | Configured repository/channel | Opens review threads for ready PRs and archives them after merge.                                                              |

Other servers use MiniSago's universal Instagram behavior; they do not receive
the WM31 role controls, commands, or scheduled feeds.

## Commands

| Command                     | Action                        |
| --------------------------- | ----------------------------- |
| `/join-wordle-channel`      | Join the Wordle channel       |
| `/leave-wordle-channel`     | Leave the Wordle channel      |
| `/join-brawlstars-channel`  | Join the Brawl Stars channel  |
| `/leave-brawlstars-channel` | Leave the Brawl Stars channel |

The channel access panel provides the same join and leave actions without slash
commands. These commands and components are accepted only in
`DISCORD_GUILD_ID`, which currently identifies the WM31 server.

## Server Setup

MiniSago needs the `bot` and `applications.commands` scopes. Its configured
permissions are:

- View Channels
- Send Messages
- Read Message History
- Manage Roles
- Create Public Threads
- Send Messages in Threads
- Manage Threads

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
