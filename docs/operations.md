# Operations

This document covers setup, maintenance commands, runtime endpoints, Discord
installation permissions, and deployment. The user-facing feature overview lives
in [README.md](../README.md).

## Local setup

1. Install dependencies and create `.env.local`.
2. Set `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, and `DISCORD_BOT_TOKEN`.
3. Set `DISCORD_GUILD_ID` for the configured-guild features, and optionally
   set `SELF_ASSIGNABLE_ROLES`.
4. Enable the Message Content privileged intent in the Discord Developer Portal
   under Bot -> Privileged Gateway Intents if the universal Instagram repost
   listener should run. Without this, Discord closes the Gateway connection
   with code `4014` and Instagram links cannot be read.
5. Sync the Discord application install settings so the bot profile
   `Add App` / `Add to Server` flow requests `applications.commands`, `bot`,
   `View Channels`, `Send Messages`, `Read Message History`, and `Manage Roles`.
6. Publish the slash commands.
7. Publish the channel access panel. Pass a channel ID or set
   `DISCORD_CHANNEL_ACCESS_CHANNEL_ID`.
8. Optionally set `TOEFL_VOCAB_CHANNEL_ID` to post one vocabulary item per day.
   The Gamer forum monitor defaults to channel `1518127531968958558`; override
   `GAMER_FORUM_CHANNEL_ID` only if it should post elsewhere.
   The X post monitor defaults to `@thsottiaux` and channel
   `1527893157168283668`.
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

## Admin and maintenance utilities

- `bun run sync:install` updates Discord's Guild Install defaults with the
  scopes and permissions the bot needs.
- `bun run register:commands` publishes the channel-role slash commands,
  either to `DISCORD_GUILD_ID` or globally when that variable is omitted.
- `bun run publish:panel` creates or updates the channel access panel in a
  chosen Discord channel.
- `bun run fetch:vocab` fetches candidate Wiktionary data for expanding the
  checked-in TOEFL vocabulary dataset.

To fetch raw Wiktionary definitions for new words, run:

```bash
bun run fetch:vocab -- abate adapt analyze
```

Review the generated output before replacing or appending to
`data/toefl-vocab.json`; Wiktionary definitions are broad, so TOEFL-friendly
examples and Traditional Chinese explanations should stay human-reviewed.

## Discord install permissions

Discord's bot profile `Add App` flow uses the application-level Guild Install
Default Install Settings, not README invite text. Run `bun run sync:install`
after setting `DISCORD_APPLICATION_ID` and `DISCORD_BOT_TOKEN` to update those
settings through the Discord API. In the Developer Portal, keep
Installation -> Install Link set to `Discord Provided Link` so the profile
button uses these defaults.

The synced permission bitfield is `268504064`, which includes:

- `View Channels`
- `Send Messages`
- `Read Message History`
- `Manage Roles`

For role assignment to work, the bot's highest role in each server must still
be above the self-assignable channel roles in Server Settings -> Roles.

## Oracle Cloud Free Tier deployment

Oracle's Always Free resources include small VM shapes that are enough for this
bot. Discord interaction endpoints must be public HTTPS URLs, so run this app
behind the shared Caddy service in the platform infrastructure repo that owns the
domain and TLS.

You need a domain or subdomain, such as `bot.example.com`, with a DNS `A`
record pointed at the Oracle VM public IP. Discord will not accept a plain HTTP
endpoint. The `oracle` repo routes the bot domain to this app on the shared
Docker network.

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
5. Clone this repository onto the VM under `/srv/platform/apps/minisago`.
6. Clone the platform infrastructure repo under `/srv/platform/infra`.
7. Create `/srv/platform/secrets/minisago.env` from this repo's
   `.env.production.example` and fill in:
   - `DISCORD_APPLICATION_ID`
   - `DISCORD_PUBLIC_KEY`
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_GUILD_ID`
   - `SELF_ASSIGNABLE_ROLES`
8. Make sure the shared `platform_shared` Docker network exists. The platform
   deploy scripts create it, or you can create it manually:

```bash
docker network create platform_shared
```

9. Start or update the service from the platform infrastructure repo:

```bash
/srv/platform/infra/scripts/deploy-minisago
cd /srv/platform/infra
sudo docker compose logs -f minisago
```

10. Confirm the proxied health endpoint after Caddy is running:

```bash
curl https://YOUR_DOMAIN/api/health
```

11. In the Discord Developer Portal, set the Interactions Endpoint URL to:

```text
https://YOUR_DOMAIN/api/interactions
```

The `oracle` Compose stack caps runtime usage so the bot remains small:

- app container: 0.25 CPU and 256 MB RAM

The `oracle` Compose stack persists scheduled-post state in the
`minisago-state` volume:

- TOEFL state when `TOEFL_VOCAB_STATE_FILE` is set to
  `/app/state/toefl-vocab-state.json`.
- Gamer forum state through the Compose-level `GAMER_FORUM_STATE_FILE` default
  of `/app/state/gamer-forum-state.json`.
- X post state when `X_POST_STATE_FILE` is set to
  `/app/state/x-post-state.json`.
