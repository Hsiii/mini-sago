# Configuration

This document covers runtime environment variables. The user-facing feature
overview lives in [README.md](../README.md), and setup/deployment procedures
live in [operations.md](operations.md).

## Core Discord configuration

| Name                     | Required | Description                                                                                         |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------- |
| `DISCORD_APPLICATION_ID` | Yes      | Discord application ID                                                                              |
| `DISCORD_PUBLIC_KEY`     | Yes      | Public key used to verify interaction signatures                                                    |
| `DISCORD_BOT_TOKEN`      | Yes      | Bot token used for Discord REST calls and the Gateway listener                                      |
| `DISCORD_GUILD_ID`       | No       | Guild for configured-guild features. Defaults to `1282936453134815275` when omitted by runtime code |

## Universal / cross-guild configuration

| Name                       | Required | Description                                                                         |
| -------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `DISCORD_GATEWAY_DISABLED` | No       | Set to `true` to run only the HTTP endpoints without the Instagram Gateway listener |

## Configured-guild role access

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

## Configured-guild scheduled posts

| Name                            | Required | Description                                                                                                                |
| ------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `TOEFL_VOCAB_CHANNEL_ID`        | No       | Discord channel ID that receives the daily TOEFL vocabulary message. Leave unset to disable                                |
| `TOEFL_VOCAB_TIME`              | No       | Local posting time in `HH:MM` format. Defaults to `08:00`                                                                  |
| `TOEFL_VOCAB_TIMEZONE`          | No       | IANA timezone used for daily scheduling. Defaults to `Asia/Taipei`                                                         |
| `TOEFL_VOCAB_STATE_FILE`        | No       | JSON file used to avoid duplicate daily sends. Defaults to `.data/toefl-vocab-state.json`; use `/app/state/...` in Docker  |
| `GAMER_FORUM_CHANNEL_ID`        | No       | Discord channel ID that receives Gamer forum post alerts. Defaults to `1518127531968958558`                                |
| `GAMER_FORUM_URL`               | No       | Gamer forum thread URL to watch. Defaults to the Mahjong Soul gift-code thread `to=112` URL                                |
| `GAMER_FORUM_CHECK_INTERVAL_MS` | No       | Forum polling interval in milliseconds. Defaults to `60000`; minimum `10000`                                               |
| `GAMER_FORUM_STATE_FILE`        | No       | JSON file used to avoid duplicate forum alerts. Defaults to `.data/gamer-forum-state.json`; use `/app/state/...` in Docker |
| `GAMER_FORUM_MONITOR_DISABLED`  | No       | Set to `true` to disable the Gamer forum monitor                                                                           |
