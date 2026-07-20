# MiniSago

<img src="assets/minisago.png" alt="MiniSago icon" width="160">

**迷你西米露 — a tiny personal Discord bot that follows you everywhere.**

MiniSago improves shared Discord spaces with better Instagram embeds, optional
channel access, selected community updates, and a guild-aware Codex chatbot
running on an unlocked Mac.

## Features

| Feature                     | Scope                               |
| --------------------------- | ----------------------------------- |
| Instagram link replies      | Every visible server/channel        |
| Codex chatbot               | Two allowed guilds; owner elsewhere |
| Channel access and commands | Configured guild only               |
| Vocabulary and feed updates | Configured guild/channel            |
| GitHub PR review threads    | Configured repository/channel       |

Other servers receive only the universal Instagram replies and owner chatbot;
deployment-specific roles, commands, and scheduled updates stay in their
configured destinations.

## Codex chatbot

Every member of guilds `917436845187563610` and `1282936453134815275` can
mention MiniSago with a conversational request. The configured owner can also
use the chatbot in other visible servers, threads, and direct messages.
MiniSago starts with up to 20 nearby human messages and its own prior replies. A
locked-down local Codex planner can keep that window, expand it to 50 or 100
same-channel messages, request guild-wide searches, or combine both before a
second Codex run answers. Users outside those guilds are silently ignored
unless they are the configured owner. Reaction emoji and counts travel with
each message so they can contribute lightweight conversational context.

The chatbot can summarize recent discussion, reason about attachments, and
search public web pages. Questions such as “When did Daniel send the meme?” use
Codex to plan up to four read-only searches across Discord's indexed guild
history. The schema-constrained plan can combine shorter text terms with
sender, link, file, and media filters. MiniSago validates and executes those
bounded reads only in channels visible to the requester, then supplies
matching channels, timestamps, and original jump links to the answer run. Guild
history can also supply evidence for questions about a member or recurring
topic. Codex makes this decision for every guild request, so a short follow-up
such as “try again” can continue the prior lookup. English and Chinese requests
can refer to the requester as “I” or “我”. Member lookup is used only to resolve
a named sender for that search; roles, join dates, and presence are not exposed
to Codex.

The chatbot is available only while the Mac is awake, unlocked, authenticated,
connected, and idle. Requests are not queued. Each run is independent;
transcripts and temporary attachments are discarded after its public reply.
The Mac accepts no inbound public connection.

## Commands

| Commands                                                | Action                    |
| ------------------------------------------------------- | ------------------------- |
| `/join-wordle-channel`, `/leave-wordle-channel`         | Toggle Wordle access      |
| `/join-brawlstars-channel`, `/leave-brawlstars-channel` | Toggle Brawl Stars access |

These commands and the equivalent channel-access panel work only in the
configured guild.

## Quick start

Configure the Discord credentials and shared Mac bridge secret described in
[Configuration](docs/configuration.md), enable Discord's Message Content
privileged intent, then deploy and load the helper:

```bash
bun run deploy
bun run mac-agent:install
bun run mac-agent:status
```

The helper starts automatically at login, disconnects when the Mac locks, and
reconnects after unlock without replaying missed requests.

## Discord requirements

Install MiniSago with the `bot` and `applications.commands` scopes. It needs to
view channels, read history, send messages and thread replies, and manage only
the configured opt-in roles. It does not need Manage Messages or Manage
Webhooks. Run only one Gateway-enabled instance per bot token.

## Development

Requires [Bun](https://bun.sh/).

```bash
bun install
bun run dev
bun test
```

See [Configuration](docs/configuration.md) for settings and
[Operations](docs/operations.md) for Discord registration, deployment, helper
security, logs, health checks, and removal.
