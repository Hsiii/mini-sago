# Operations

This document covers setup, maintenance commands, runtime endpoints, Discord
installation permissions, and deployment. The user-facing feature overview lives
in [README.md](../README.md).

## Feature boundaries

- **Universal:** Instagram link replies run in every server and channel where
  MiniSago has the required message permissions. Hsi's owner-only chatbot
  mentions work in those locations and in direct messages when the Mac helper
  is available.
- **Configured guild:** the channel access panel, Wordle/Brawl Stars commands,
  TOEFL posts, Gamer forum alerts, and X alerts are restricted to
  `DISCORD_GUILD_ID`. The current deployment uses the WM31 guild
  `1282936453134815275`.
- **Configured repository/channel:** the GitHub webhook bridge accepts only
  `Hsiii/health-check-system` pull request events and posts only to
  `GITHUB_PR_THREAD_CHANNEL_ID`.

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
   `View Channels`, `Send Messages`, `Read Message History`, `Manage Roles`,
   `Create Public Threads`, `Send Messages in Threads`, and `Manage Threads`.
6. Publish the slash commands.
7. Publish the channel access panel. Pass a channel ID or set
   `DISCORD_CHANNEL_ACCESS_CHANNEL_ID`.
8. Optionally set `TOEFL_VOCAB_CHANNEL_ID` to post one vocabulary item per day.
   The Gamer forum monitor defaults to channel `1518127531968958558`; override
   `GAMER_FORUM_CHANNEL_ID` only if it should post elsewhere.
   The X post monitor defaults to `@thsottiaux` and channel
   `1527893157168283668`.
9. To enable PR review threads, set `GITHUB_WEBHOOK_SECRET`, install MiniSago in
   the server containing `GITHUB_PR_THREAD_CHANNEL_ID`, and configure the
   repository webhook described below.
10. Run locally or deploy, then point the Discord Interactions Endpoint URL at
    `/api/interactions`.
11. To enable the private chatbot, configure the same
    `MINISAGO_MAC_BRIDGE_SECRET` in production and `.env.local`, deploy the
    hosted bridge, then install the Mac helper as described below.

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

## Private Codex chatbot

The hosted process receives Hsi's `@MiniSago` messages through the existing
Discord Gateway. It fetches the same channel's previous 24 hours, keeps at most
100 human messages, and sends one transient job through the authenticated
WebSocket at `/api/mac-agent/ws`. There is no polling, public Mac endpoint, or
durable queue.

The Mac helper runs `gpt-5.6-terra` with high reasoning and live public web
search. Each run is ephemeral. Codex receives only the current transcript and
up to 10 relevant supported attachments of at most 20 MB each. Images, PDFs,
DOCX, and common text formats are supported. Temporary files are removed after
the run, and output is shortened to one Discord message.

The local process uses an isolated workspace and Codex home, a restrictive
permission profile, and a macOS process sandbox that prevents Codex from
launching child processes. Local commands, code execution, file changes, normal
Codex configuration, memories, MCP servers, plugins, and private browser
sessions are unavailable. Hosted web search remains available.

### Install the Mac helper

Prerequisites:

- Bun and the Xcode command-line tools, including `swiftc`.
- A working local Codex login: the installer expects `~/.codex/auth.json`.
- The same random `MINISAGO_MAC_BRIDGE_SECRET` in `.env.local` and the hosted
  `bot-core` environment.
- The hosted service deployed with WebSocket upgrade support at
  `/api/mac-agent/ws`.

Run:

```bash
bun run mac-agent:install
bun run mac-agent:status
```

The installer compiles a small native session monitor and registers
`dev.hsichen.minisago-mac-agent` as a per-user LaunchAgent. It connects only
while the session is unlocked, disconnects before sleep or on lock, reconnects
after unlock, and starts automatically at login. A display sleeping without a
session lock does not disable it.

Metadata-only logs live under
`~/Library/Application Support/MiniSago/logs`. They contain job IDs, timestamps,
durations, availability, and failures—not prompts, Discord messages, answers,
links, or attachment contents.

To stop and remove the helper, its secret file, compiled monitor, and logs:

```bash
bun run mac-agent:uninstall
```

Uninstalling does not change the normal `~/.codex` login or configuration.

## Endpoints

- `GET /api/health` returns configuration health.
- `GET /api/mac-agent/ws` upgrades an authenticated Mac helper connection to a
  WebSocket. It returns `404` when the bridge secret is not configured.
- `POST /api/interactions` handles Discord slash commands and panel
  components.
- `POST /api/github/webhook` verifies and handles GitHub pull request events.

## GitHub pull request webhook

In `Hsiii/health-check-system` under Settings -> Webhooks, add a repository
webhook with:

- Payload URL: `https://bot.hsichen.dev/api/github/webhook`
- Content type: `application/json`
- Secret: the same random value as `GITHUB_WEBHOOK_SECRET`
- Events: select only **Pull requests**

The `ready_for_review` action creates a public thread named after the PR and
posts the review request. Repeated deliveries reuse the saved thread instead of
creating duplicates. A `closed` action archives the thread only when GitHub
marks the PR as merged.

The production bridge is deployed at `bot.hsichen.dev`. MiniSago's access to
the `專案討論` text channel (`1521506395034226830`) in guild
`1521168712579682567` has been verified for viewing, sending messages, reading
history, creating public threads, sending in threads, and managing threads.

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
- `bun run mac-agent:install`, `mac-agent:status`, and `mac-agent:uninstall`
  manage the unlocked-session Codex helper on this Mac.

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

The synced permission bitfield is `326686018560`, which includes:

- `View Channels`
- `Send Messages`
- `Read Message History`
- `Manage Roles`
- `Manage Threads`
- `Create Public Threads`
- `Send Messages in Threads`

The integer is used by Discord's API and generated install URL; Server Settings
does not provide an integer field. For an existing installation, open Server
Settings -> Roles -> 迷你西米露 and configure the corresponding permission
checkboxes. Application install defaults affect new installations and do not
retroactively rewrite an existing server role.

The first three permissions support universal Instagram replies and owner
chatbot context. `Manage Roles` is needed only for the configured-guild channel
access commands and panel.
The thread permissions let the GitHub bridge create public threads, add team
members, post review requests, and archive threads after merge. MiniSago does
not request Manage Messages or Manage Webhooks. Channel-specific overrides must
still allow the relevant permissions in each target channel.

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
curl https://bot.hsichen.dev/api/health
```

```text
https://bot.hsichen.dev/api/interactions
https://bot.hsichen.dev/api/github/webhook
wss://bot.hsichen.dev/api/mac-agent/ws
```

The edge proxy must preserve WebSocket upgrade headers for the Mac bridge.

The platform caps the bot at 0.25 CPU and 256 MB RAM. Scheduled-post state is
stored in the external `platform_bot-core-state` volume:

- TOEFL state when `TOEFL_VOCAB_STATE_FILE` is set to
  `/app/state/toefl-vocab-state.json`.
- Gamer forum state through the Compose-level `GAMER_FORUM_STATE_FILE` default
  of `/app/state/gamer-forum-state.json`.
- X post state when `X_POST_STATE_FILE` is set to
  `/app/state/x-post-state.json`.
- GitHub PR thread state when `GITHUB_PR_THREAD_STATE_FILE` is set to
  `/app/state/github-pr-threads.json`.
