# Operations

This document covers setup, maintenance commands, runtime endpoints, Discord
installation permissions, and deployment. The user-facing feature overview lives
in [README.md](../README.md).

## Feature boundaries

- **Universal:** Instagram link replies run in every server and channel where
  MiniSago has the required message permissions.
- **Configured guild:** the channel access panel, Wordle/Brawl Stars commands,
  TOEFL posts, Gamer forum alerts, and X alerts are restricted to
  `DISCORD_GUILD_ID`. The current deployment uses the WM31 guild
  `1282936453134815275`.

Installing MiniSago in another server does not expose or activate the WM31 role
controls or scheduled feeds there.

## Local setup

1. Install dependencies and copy `.env.example` to `.env.local`.
2. Set `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, and `DISCORD_BOT_TOKEN`.
3. Set `DISCORD_GUILD_ID` for the one server allowed to use configured-guild
   features, and optionally set `SELF_ASSIGNABLE_ROLES`. The checked-in defaults
   target the WM31 Wordle and Brawl Stars roles and should not be treated as
   universal examples.
4. Enable the Message Content privileged intent in the Discord Developer Portal
   under Bot -> Privileged Gateway Intents if universal Instagram link replies
   should run. Without it, Discord closes the Gateway connection with code
   `4014` and Instagram messages cannot be read.
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

If production already uses the same bot token, set
`DISCORD_GATEWAY_DISABLED=true` locally before running the development server.
Discord delivers Gateway events to every connected unsharded instance, so a
second listener can produce duplicate replies. HTTP interactions and local
endpoint development continue to work with the Gateway disabled.

```bash
bun install
bun run sync:install
bun run register:commands
bun run publish:panel -- 1520033288767537263
bun run dev
```

## Instagram link replies

The Instagram feature is a universal Gateway listener, not a Discord webhook.
For each non-bot server message containing an `instagram.com` URL, MiniSago:

1. leaves the user's message untouched;
2. converts each Instagram URL to the matching `kkinstagram.com` URL; and
3. replies to the original message with only the converted URL or URLs.

MiniSago ignores bot and webhook-authored messages to avoid loops. It does not
need Manage Messages or Manage Webhooks, and there should be no MiniSago or
`WM31 Instagram` entries under Server Settings -> Integrations -> Webhooks.

If messages are deleted or reappear under a user's display name, a retired
webhook-based instance is still running. Stop that duplicate deployment first,
then delete its webhook from Server Settings -> Integrations -> Webhooks. Keep
exactly one Gateway-enabled MiniSago instance running for a bot token.

The Gateway connection is outbound, so Instagram replies do not require a
public webhook endpoint. The `/api/interactions` endpoint is still required for
slash commands and channel access components.

## Endpoints

- `GET /api/health` returns configuration health.
- `POST /api/interactions` handles Discord slash commands and panel
  components.

## Admin and maintenance utilities

- `bun run sync:install` updates Discord's Guild Install defaults with the
  scopes and permissions the bot needs.
- `bun run register:commands` publishes the channel-role slash commands to
  `DISCORD_GUILD_ID`. Omitting it publishes the commands globally, but the
  runtime still rejects them outside its configured guild; normal deployments
  should therefore always set the guild ID.
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

The integer is used by Discord's API and generated install URL; Server Settings
does not provide an integer field. For an existing installation, open Server
Settings -> Roles -> 迷你西米露 and configure the corresponding permission
checkboxes. Application install defaults affect new installations and do not
retroactively rewrite an existing server role.

The first three permissions support universal Instagram replies. `Manage Roles`
is needed only for the configured-guild channel access commands and panel.
MiniSago does not request Manage Messages or Manage Webhooks. Channel-specific
overrides must still allow View Channel, Send Messages, and Read Message History
where Instagram replies should work.

Servers that only use universal Instagram replies may disable Manage Roles for
MiniSago. That does not affect link replies; it only prevents the configured
channel-role feature, which is not available outside `DISCORD_GUILD_ID` anyway.

For role assignment to work, the bot's highest role in each server must still
be above the self-assignable channel roles in Server Settings -> Roles.

## Production deployment

Every push to `main` publishes Linux AMD64 images to GitHub Container Registry
under `ghcr.io/hsiii/minisago`. The workflow maintains a moving `main` tag and
an immutable `sha-<commit>` tag.

`bun run deploy` pushes `main`, waits for the image workflow, and asks the
platform operations checkout at `/srv/platform/operations` to deploy the
neutral `bot-core` service:

```bash
bun run deploy
```

The VM pulls the published image rather than cloning or building this
repository. Production configuration lives in
`/srv/platform/secrets/bot-core.env`, and the container joins the external
`platform_edge` network under the `bot-core` alias.

Confirm the public endpoints after deployment:

```bash
curl https://YOUR_DOMAIN/api/health
```

```text
https://YOUR_DOMAIN/api/interactions
```

The platform caps the bot at 0.25 CPU and 256 MB RAM. Scheduled-post state is
stored in the external `platform_bot-core-state` volume:

- TOEFL state when `TOEFL_VOCAB_STATE_FILE` is set to
  `/app/state/toefl-vocab-state.json`.
- Gamer forum state through the Compose-level `GAMER_FORUM_STATE_FILE` default
  of `/app/state/gamer-forum-state.json`.
- X post state when `X_POST_STATE_FILE` is set to
  `/app/state/x-post-state.json`.
