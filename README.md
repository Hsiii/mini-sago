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

## Use it

1. Install dependencies and create `.env.local`.
2. Set `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, and `DISCORD_BOT_TOKEN`.
3. Set `DISCORD_GUILD_ID` for the Wordle/荒野 role-control server, and
   optionally set `SELF_ASSIGNABLE_ROLES`.
4. Enable the Message Content privileged intent in the Discord Developer Portal
   under Bot -> Privileged Gateway Intents. Without this, Discord closes the
   Gateway connection with code `4014` and Instagram links cannot be read.
5. Invite the bot with `applications.commands` plus bot permissions for
   `Manage Roles`, `Manage Messages`, and `Manage Webhooks`.
6. Publish the slash commands.
7. Publish the channel access panel. Pass a channel ID or set
   `DISCORD_CHANNEL_ACCESS_CHANNEL_ID`.
8. Run locally or deploy, then point the Discord Interactions Endpoint URL at
   `/api/interactions`.

```bash
bun install
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

## Oracle Cloud Free Tier deployment

Oracle's Always Free resources include small VM shapes that are enough for this
bot. Discord interaction endpoints must be public HTTPS URLs, so the included
Docker Compose stack runs the service behind Caddy for automatic TLS.

You need a domain or subdomain, such as `bot.example.com`, with a DNS `A`
record pointed at the Oracle VM public IP. Discord will not accept a plain HTTP
endpoint, and Caddy needs a hostname to issue a trusted TLS certificate.

The included Caddy config also supports a `/wm31` path prefix, so you can use
`https://bot.example.com/wm31/api/interactions` while keeping `DOMAIN` set to
only `bot.example.com`.

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
5. Clone this repository onto the VM.
6. Create `.env.production` from `.env.production.example` and fill in:
   - `DOMAIN` without a path, such as `bot.example.com`
   - `DISCORD_APPLICATION_ID`
   - `DISCORD_PUBLIC_KEY`
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_GUILD_ID`
   - `SELF_ASSIGNABLE_ROLES`
7. Start the service:

```bash
docker compose up -d --build
docker compose logs -f
```

8. Confirm the health endpoint:

```bash
curl https://$DOMAIN/wm31/api/health
```

9. In the Discord Developer Portal, set the Interactions Endpoint URL to:

```text
https://YOUR_DOMAIN/wm31/api/interactions
```

The production Compose stack caps runtime usage so the bot remains small:

- app container: 0.25 CPU and 256 MB RAM
- Caddy container: 0.25 CPU and 128 MB RAM

## Environment variables

| Name                                | Required | Description                                                                                                                      |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_APPLICATION_ID`            | Yes      | Discord application ID                                                                                                           |
| `DISCORD_PUBLIC_KEY`                | Yes      | Public key used to verify interaction signatures                                                                                 |
| `DISCORD_BOT_TOKEN`                 | Yes      | Bot token used for Discord REST role updates                                                                                     |
| `DISCORD_GUILD_ID`                  | Yes      | Guild where Wordle/荒野 role-control interactions are allowed. Defaults to `1282936453134815275` when omitted                    |
| `DISCORD_CHANNEL_ACCESS_CHANNEL_ID` | No       | Default Discord channel ID for `bun run publish:panel`                                                                           |
| `DISCORD_GATEWAY_DISABLED`          | No       | Set to `true` to run only the HTTP endpoints without the Instagram Gateway listener                                              |
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
