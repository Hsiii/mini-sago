# Configuration

This document covers runtime environment variables. The user-facing feature
overview lives in [README.md](../README.md), and setup/deployment procedures
live in [operations.md](operations.md).

## Core Discord configuration

| Name                     | Required | Description                                                                                                         |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_APPLICATION_ID` | Yes      | Discord application ID                                                                                              |
| `DISCORD_PUBLIC_KEY`     | Yes      | Public key used to verify interaction signatures                                                                    |
| `DISCORD_BOT_TOKEN`      | Yes      | Bot token used for Discord REST calls and the Gateway listener                                                      |
| `DISCORD_GUILD_ID`       | No       | Only guild allowed to use role access and scheduled-post features. Defaults to the WM31 guild `1282936453134815275` |

`DISCORD_GUILD_ID` is the boundary between universal and server-specific
behavior. Guilds other than this value cannot use the Wordle/Brawl Stars
commands, channel access panel, or this deployment's scheduled posts. Chatbot
access is governed separately by its two built-in allowed guilds and owner
fallback.

## Universal / cross-guild configuration

| Name                         | Required | Description                                                                                                                     |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_GATEWAY_DISABLED`   | No       | Set to `true` to run only HTTP features and disable universal Instagram replies and chatbot mentions                            |
| `MINISAGO_MAC_BRIDGE_SECRET` | Chatbot  | High-entropy secret shared only by the hosted MiniSago process and Codex worker; leaving it blank disables the WebSocket bridge |

Gateway features are enabled by default whenever `DISCORD_BOT_TOKEN` is set and
`DISCORD_GATEWAY_DISABLED` is not `true`. They work in every server and channel
where MiniSago can view messages, read message history, and send messages.
Instagram handling replies with only converted `kkinstagram.com` URLs, leaves
the original message untouched, and never creates webhooks.

Only one Gateway-enabled instance should use a bot token at a time. When
production is active, use `DISCORD_GATEWAY_DISABLED=true` in local or temporary
environments unless that instance is intentionally replacing production.

## Codex chatbot worker

These values are consumed by `bun run mac-agent:install` from `.env.local`. Only
the bridge secret must also be present in production.

| Name                               | Required  | Description                                                                                             |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| `MINISAGO_MAC_BRIDGE_SECRET`       | Yes       | Same random secret configured on the hosted server                                                      |
| `MINISAGO_BRIDGE_URL`              | No        | Hosted WebSocket URL; defaults to `wss://bot.hsichen.dev/api/mac-agent/ws`; plain `ws://` is local-only |
| `MINISAGO_CODEX_PATH`              | No        | Codex executable; defaults to the binary bundled in `/Applications/ChatGPT.app`                         |
| `MINISAGO_CODEX_HOME`              | No        | Isolated helper state directory; the installer defaults under `~/Library/Application Support/MiniSago`  |
| `MINISAGO_SESSION_MONITOR_PATH`    | No        | Compiled native lock monitor; the installer creates and configures it automatically                     |
| `MINISAGO_TRACE_DATABASE_PATH`     | No        | Local response-trace database; defaults under the platform state directory                              |
| `MINISAGO_WORKSPACE_ROOT`          | No        | Owner dev-mode workspace; defaults to `~/Projects` on Mac and `/workspace` in the worker container      |
| `MINISAGO_MAX_CONCURRENT_JOBS`     | No        | Maximum concurrent Codex jobs advertised to the bridge; defaults to `2`, bounded from `1` to `16`       |
| `MINISAGO_HEADLESS`                | No        | Set to `true` on Linux to stay connected without the macOS session monitor                              |
| `MINISAGO_WORKER_ID`               | No        | Stable worker identity; defaults from the host, while the container image uses `oracle`                 |
| `MINISAGO_WORKER_CAPABILITIES`     | No        | Comma-separated `chat`, `dev-read`, `dev-write`, and `mac`; only a Mac worker should advertise `mac`    |
| `MINISAGO_WORKER_PRIORITY`         | No        | Scheduler priority from `0` to `1000`; cloud defaults to `100` and Mac to `50` for fallback routing     |
| `MINISAGO_GITHUB_REPOSITORIES`     | For dev   | Exact `owner/repository` scopes advertised to the bridge; credentials must be scoped to the same repos  |
| `MINISAGO_GITHUB_READ_CONFIG_DIR`  | For dev   | GitHub CLI config containing the repo-scoped read-only credential used by `dev-read`                    |
| `MINISAGO_GITHUB_WRITE_CONFIG_DIR` | For write | Separate GitHub CLI config containing the repo-scoped write credential used by `dev-write`              |
| `MINISAGO_GITHUB_WORKTREE_ROOT`    | No        | Per-job isolated worktree root; defaults to `<workspace>/worktrees`                                     |

The helper uses the existing `~/.codex/auth.json` through a symlink inside its
isolated Codex home. It does not copy the credential or load normal Codex
config, skills, memories, plugins, MCP servers, or repository instructions.
The trace database is readable only by the local user and is automatically
pruned after 14 days or when it exceeds 250 MB.

The Discord owner ID is a code-level security boundary. Owner requests first
use GPT-5.6 Luna with low reasoning to choose `chat`, `dev-read`, or
`dev-write`; Mac targeting is independent. Chat requests use Luna with high
reasoning; both dev profiles use GPT-5.6 Sol with medium reasoning and receive
only the selected per-job checkout. Other authorized
community members use Luna with high reasoning and are limited to conversational,
summarization, and public-information requests. GitHub pull-request reviews,
issue mutations, code changes, command execution, and similar privileged
requests are rejected before they reach the worker, then checked again by the
worker before Codex runs.

Multiple workers may connect with the same bridge secret as long as they use
different worker IDs. The bridge prefers the highest-priority compatible
worker, falls back when it is full or offline, and keeps every multi-stage
workflow on one worker after routing. Luna selects the `mac` target only when
the request explicitly needs a resource on Hsi's Mac.

## Owner GitHub automation

The worker image includes `gh`, but read and write authentication live in
separate host secret directories or Docker volumes. The checked-in Compose
stack runs separate read and write worker containers, and mounts only the
credential each worker advertises. `dev-read` is the default
for PR review and receives only the repo-scoped read credential. `dev-write`
is selected only when the owner's own request explicitly requires mutation and
receives the separate repo-scoped write credential. MiniSago does not accept,
copy, or inject a GitHub token through its own configuration.

Only the final owner-authorized dev answer receives developer command and
network permissions. Luna routing, Discord context planning, identity
resolution, community jobs, and ordinary owner chat cannot execute `gh`. The
bridge rejects a dev job unless the worker advertised its exact repository;
the worker then clones only that repository into a disposable job checkout.
Untrusted PR content can influence analysis but cannot upgrade `dev-read` to
`dev-write` because the deterministic mutation check uses only the owner's
request.

The read credential must have read-only repository permissions. The write
credential may create issues, branches, commits, and draft PRs, but GitHub
rulesets must deny protected-branch pushes and merging for that identity. Do
not grant either credential provider, deployment, organization-admin, or
unrelated-repository access. Exact setup remains tracked in
[issue #12](https://github.com/Hsiii/mini-sago/issues/12).

Repository contents, diffs, issues, comments, and command output remain
untrusted data. MiniSago is instructed to create issue mutations only when Hsi
asks, keep reviews read-only unless asked to post them, never push a protected
branch, and deliver code changes as draft PRs without merging or marking them
ready.

## GitHub pull request review threads

| Name                          | Required | Description                                                                                                                              |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_WEBHOOK_SECRET`       | Yes      | Shared secret used to verify GitHub's `X-Hub-Signature-256`. Leaving it blank disables the endpoint                                      |
| `GITHUB_PR_THREAD_CHANNEL_ID` | No       | Text channel where public review threads are created. Defaults to `1521506395034226830`                                                  |
| `GITHUB_PR_THREAD_STATE_FILE` | No       | PR-to-thread mapping used for idempotency and merge archival. Defaults to `.data/github-pr-threads.json`; use `/app/state/...` in Docker |

The bridge accepts only `pull_request` events for
`Hsiii/health-check-system`. When `Hsiii` marks a draft ready, Daniel and
Jasmine are mentioned. PRs by Daniel, Jasmine, or another author mention Hsi.
Known team authors are also explicitly added to the public thread.
The review request containing the pull-request link is pinned in the thread.

## Configured-guild role access (WM31 by default)

| Name                                | Required | Description                                                                                                                      |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_CHANNEL_ACCESS_CHANNEL_ID` | No       | Default Discord channel ID for `bun run publish:panel`                                                                           |
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

The defaults above are existing WM31 channel roles. They are intentionally not
portable defaults for other servers. Change both `DISCORD_GUILD_ID` and
`SELF_ASSIGNABLE_ROLES` only when deliberately moving or repurposing the
configured-guild role feature.

## Configured-guild scheduled posts

Every configured channel below must belong to `DISCORD_GUILD_ID`. These are
deployment-specific outbound jobs, not features automatically enabled for every
server where MiniSago is installed.

| Name                           | Required | Description                                                                                                                |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `TOEFL_VOCAB_CHANNEL_ID`       | No       | Discord channel ID that receives the daily TOEFL vocabulary message. Leave unset to disable                                |
| `TOEFL_VOCAB_TIME`             | No       | Local posting time in `HH:MM` format. Defaults to `08:00`                                                                  |
| `TOEFL_VOCAB_TIMEZONE`         | No       | IANA timezone used for daily scheduling. Defaults to `Asia/Taipei`                                                         |
| `TOEFL_VOCAB_STATE_FILE`       | No       | JSON file used to avoid duplicate daily sends. Defaults to `.data/toefl-vocab-state.json`; use `/app/state/...` in Docker  |
| `GAMER_FORUM_CHANNEL_ID`       | No       | Discord channel ID that receives Gamer forum post alerts. Defaults to `1518127531968958558`                                |
| `GAMER_FORUM_URL`              | No       | Gamer forum thread URL to watch. Defaults to the Mahjong Soul gift-code thread `to=112` URL                                |
| `GAMER_FORUM_CHECK_TIMES`      | No       | Comma-separated local check times. Defaults to `08:30,20:30`                                                               |
| `GAMER_FORUM_TIMEZONE`         | No       | IANA timezone for forum checks. Defaults to `Asia/Taipei`                                                                  |
| `GAMER_FORUM_READER_BASE_URL`  | No       | Reader prefix used to fetch normalized forum content. Defaults to `https://r.jina.ai/`                                     |
| `GAMER_FORUM_STATE_FILE`       | No       | JSON file used to avoid duplicate forum alerts. Defaults to `.data/gamer-forum-state.json`; use `/app/state/...` in Docker |
| `GAMER_FORUM_MONITOR_DISABLED` | No       | Set to `true` to disable the Gamer forum monitor                                                                           |
| `X_POST_HANDLE`                | No       | X handle to monitor. Defaults to `thsottiaux`                                                                              |
| `X_POST_CHANNEL_ID`            | No       | Discord channel that receives new X posts. Defaults to `1527893157168283668`                                               |
| `X_POST_FEED_URL`              | No       | RSS source. Defaults to the FxEmbed feed generated from `X_POST_HANDLE`                                                    |
| `X_POST_CHECK_INTERVAL_MS`     | No       | X feed polling interval in milliseconds. Defaults to `300000` (5 minutes); minimum `10000`                                 |
| `X_POST_STATE_FILE`            | No       | JSON file used to avoid duplicate X posts. Defaults to `.data/x-post-state.json`; use `/app/state/...` in Docker           |
| `X_POST_MONITOR_DISABLED`      | No       | Set to `true` to disable the X post monitor                                                                                |
