# MiniSago

<img src="assets/minisago.png" alt="MiniSago icon" width="160">

**迷你西米露 — a small Discord companion for chat, links, community access,
and useful updates.**

MiniSago quietly improves the Discord servers she joins. She fixes Instagram
Reel embeds, answers questions with recent conversation context, lets members
open optional channels for themselves, posts selected community updates, and
organizes GitHub pull-request discussions.

## What MiniSago does

### Makes Instagram links easier to view

Post an Instagram link normally. MiniSago replies with the matching
`kkinstagram.com` link so the Reel or post embeds more reliably in Discord.

This works in every server and channel MiniSago can see. She never deletes or
replaces the original message.

### Answers questions about the conversation

Mention the **MiniSago bot account** and ask a question. You can also reply to
one of her answers to continue the conversation without mentioning her again.

MiniSago can:

- summarize recent conversation;
- answer questions about images, PDFs, documents, and text attachments;
- search the public web when current information is needed;
- find older messages in Discord history and return links to the originals;
- reason carefully about identity questions using available server evidence;
- explain the observable sources and retrieval choices behind her previous
  answer.

She only searches channels that the person asking can access. Member roles,
join dates, and presence are not sent to Codex. Temporary attachment downloads
are removed after the response, and local diagnostic traces expire after 14
days.

The chatbot currently works for:

- every member of **鄭仁誠觀察日記** (`917436845187563610`);
- every member of **WM31** (`1282936453134815275`);
- every member with access to **#荒野** (`1517766866964316201`);
- the configured owner in any other visible server, thread, or direct message.

> [!TIP]
> In Discord's mention picker, choose MiniSago under **Members/Apps**, not a
> similarly named role. A role mention does not start the chatbot.

Chat replies require the Mac helper to be awake, unlocked, connected, and idle.
Requests received while it is unavailable are not queued.

### Lets members open optional channels

Members of the configured WM31 server can grant or remove their own access to
the Wordle and Brawl Stars channels. This keeps optional channels out of the way
without requiring a moderator to manage every request.

| Command                     | Purpose                      |
| --------------------------- | ---------------------------- |
| `/join-wordle-channel`      | Open the Wordle channel      |
| `/leave-wordle-channel`     | Hide the Wordle channel      |
| `/join-brawlstars-channel`  | Open the Brawl Stars channel |
| `/leave-brawlstars-channel` | Hide the Brawl Stars channel |

The same choices are available through the channel-access panel.

### Posts useful community updates

MiniSago can publish a daily TOEFL vocabulary card and monitor selected Gamer
forum and X feeds. Each update stays in its configured destination instead of
following the bot into every server.

### Organizes pull-request reviews

For the configured GitHub repository, MiniSago opens a Discord discussion
thread for each pull request, adds the relevant reviewers, and archives the
thread after the pull request is merged.

## Where features work

| Feature                 | Availability                                      |
| ----------------------- | ------------------------------------------------- |
| Instagram link replies  | Every visible server and channel                  |
| Chatbot                 | Allowed guilds, #荒野, and the owner elsewhere    |
| Optional channel access | Configured WM31 server only                       |
| Vocabulary and feeds    | Their configured server and channel               |
| Pull-request threads    | The configured repository and Discord destination |

## Run your own instance

MiniSago requires [Bun](https://bun.sh/), a Discord application, and a Mac with
a working Codex login for chatbot responses.

Configure the Discord credentials and shared Mac bridge secret described in
[Configuration](docs/configuration.md), enable Discord's Message Content
privileged intent, then deploy and install the helper:

```bash
bun install
bun run deploy
bun run mac-agent:install
bun run mac-agent:status
```

The helper starts automatically at login, disconnects when the Mac locks, and
reconnects after unlock without replaying missed requests.

Install the Discord application with the `bot` and `applications.commands`
scopes. It needs permission to view channels, read message history, send
messages and thread replies, and manage only the configured opt-in roles. It
does not need Manage Messages or Manage Webhooks.

Run only one Gateway-enabled instance per bot token. See
[Configuration](docs/configuration.md) for environment settings and
[Operations](docs/operations.md) for registration, deployment, security, logs,
health checks, and removal.

## Development

```bash
bun install
bun run dev
bun test
```
