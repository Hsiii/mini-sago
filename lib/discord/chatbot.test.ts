import { describe, expect, test } from "bun:test";

import {
  canMemberSearchChannel,
  extractMentionRequest,
  fallbackGuildSearchQueries,
  formatDiscordAnswer,
  getNearbyHumanMessages,
  getRecentHumanMessages,
  isConversationContextMessage,
  isChatbotAuthorized,
  isHumanContextMessage,
  parseDiscordContextPlan,
  searchGuildMessages,
  toChatbotMessage,
} from "./chatbot";

const BOT_ID = "123456789012345678";

describe("Discord chatbot", () => {
  test("extracts a natural request from either Discord mention form", () => {
    expect(extractMentionRequest(`<@${BOT_ID}> summarize this`, BOT_ID)).toBe(
      "summarize this",
    );
    expect(extractMentionRequest(`hello <@!${BOT_ID}>`, BOT_ID)).toBe("hello");
    expect(extractMentionRequest("summarize this", BOT_ID)).toBeNull();
  });

  test("authorizes every member of the two chatbot guilds", () => {
    expect(isChatbotAuthorized("member-1", "917436845187563610")).toBe(true);
    expect(isChatbotAuthorized("member-2", "1282936453134815275")).toBe(true);
    expect(isChatbotAuthorized("member-3", "other-guild")).toBe(false);
    expect(isChatbotAuthorized("member-3")).toBe(false);
    expect(isChatbotAuthorized("917446775873343600", "other-guild")).toBe(true);
    expect(isChatbotAuthorized("917446775873343600")).toBe(true);
  });

  test("accepts only human context messages other than the request", () => {
    const base = {
      id: "message-1",
      channel_id: "channel-1",
      content: "hello",
      timestamp: "2026-07-20T11:00:00.000Z",
      author: { id: "user-1", username: "Hsi" },
    };

    expect(isHumanContextMessage(base, "request")).toBe(true);
    expect(isHumanContextMessage(base, "message-1")).toBe(false);
    expect(
      isHumanContextMessage(
        { ...base, author: { ...base.author, bot: true } },
        "request",
      ),
    ).toBe(false);
  });

  test("backfills beyond seven days until it has 100 human messages", async () => {
    const recentPage = Array.from({ length: 100 }, (_, index) => ({
      id: `recent-${index}`,
      channel_id: "channel-1",
      content: `recent ${index}`,
      timestamp: "2026-07-19T12:00:00.000Z",
      author: {
        id: `user-${index}`,
        username: `Recent ${index}`,
        bot: index % 2 === 1,
      },
    }));
    const olderPage = Array.from({ length: 50 }, (_, index) => ({
      id: `older-${index}`,
      channel_id: "channel-1",
      content: `older ${index}`,
      timestamp: "2026-07-01T12:00:00.000Z",
      author: { id: `older-user-${index}`, username: `Older ${index}` },
    }));
    const requestedPaths: string[] = [];

    const messages = await getRecentHumanMessages({
      channelId: "channel-1",
      requestMessageId: "request",
      botUserId: BOT_ID,
      now: new Date("2026-07-20T12:00:00.000Z"),
      discordRequest: async (path) => {
        requestedPaths.push(path);
        return (requestedPaths.length === 1 ? recentPage : olderPage) as never;
      },
    });

    expect(requestedPaths).toHaveLength(2);
    expect(messages).toHaveLength(100);
    expect(messages[0]?.id).toBe("older-49");
    expect(messages.at(-1)?.id).toBe("recent-0");
  });

  test("loads a small human context window around the request", async () => {
    const requestedPaths: string[] = [];
    const nearby = Array.from({ length: 25 }, (_, index) => ({
      id: index === 4 ? "request" : `message-${index}`,
      channel_id: "channel-1",
      content: `message ${index}`,
      timestamp: `2026-07-20T11:${String(59 - index).padStart(2, "0")}:00.000Z`,
      author: {
        id: `user-${index}`,
        username: `User ${index}`,
        bot: index === 3,
      },
    }));

    const messages = await getNearbyHumanMessages({
      channelId: "channel-1",
      requestMessageId: "request",
      botUserId: BOT_ID,
      discordRequest: async (path) => {
        requestedPaths.push(path);
        return nearby as never;
      },
    });

    expect(requestedPaths).toEqual([
      "/channels/channel-1/messages?around=request&limit=25",
    ]);
    expect(messages).toHaveLength(20);
    expect(messages[0]?.id).toBe("message-21");
    expect(messages.at(-1)?.id).toBe("message-0");
    expect(messages.some((message) => message.id === "request")).toBe(false);
    expect(messages.some((message) => message.id === "message-3")).toBe(false);
  });

  test("keeps MiniSago replies as assistant context but excludes other bots", () => {
    const base = {
      id: "message-1",
      channel_id: "channel-1",
      content: "earlier answer",
      timestamp: "2026-07-20T11:00:00.000Z",
      author: { id: BOT_ID, username: "MiniSago", bot: true },
    };

    expect(isConversationContextMessage(base, "request", BOT_ID)).toBe(true);
    expect(
      isConversationContextMessage(
        { ...base, author: { ...base.author, id: "other-bot" } },
        "request",
        BOT_ID,
      ),
    ).toBe(false);
    expect(toChatbotMessage(base, BOT_ID).role).toBe("assistant");
  });

  test("validates and limits Codex Discord context plans", () => {
    expect(
      parseDiscordContextPlan(`\`\`\`json
{"history":"extended","queries":[{"author":"self","content":"new app"},{"has":["link","file","invalid"]},{"embedType":"gif"},{"attachmentExtension":".pdf"},{"content":"ignored"}]}
\`\`\``),
    ).toEqual({
      history: "extended",
      queries: [
        { author: "self", content: "new app" },
        { has: ["link", "file"] },
        { embedType: "gif" },
        { attachmentExtension: "pdf" },
      ],
    });
    expect(parseDiscordContextPlan("not json")).toEqual({
      history: "local",
      queries: [],
    });
  });

  test("falls back to guild-wide author and mention searches for member questions", () => {
    expect(fallbackGuildSearchQueries("誰是 6uc")).toEqual([
      { author: "6uc", sortBy: "timestamp", sortOrder: "desc" },
      { content: "6uc", sortBy: "relevance", sortOrder: "desc" },
    ]);
    expect(fallbackGuildSearchQueries("6uc 是誰？")).toEqual([
      { author: "6uc", sortBy: "timestamp", sortOrder: "desc" },
      { content: "6uc", sortBy: "relevance", sortOrder: "desc" },
    ]);
    expect(
      fallbackGuildSearchQueries("explain TCP congestion control"),
    ).toEqual([]);
  });

  test("searches the guild and returns channel names and safe jump links", async () => {
    const requestedPaths: string[] = [];
    const results = await searchGuildMessages({
      guildId: "guild-1",
      requesterUserId: "owner-1",
      requesterRoleIds: ["role-1"],
      currentChannelId: "channel-1",
      requestMessageId: "request-1",
      queries: [{ author: "Daniel", has: ["image"] }],
      discordRequest: async (path) => {
        requestedPaths.push(path);
        if (path.includes("/members/search?")) {
          return [
            {
              nick: "Daniel",
              user: { id: "user-1", username: "daniel" },
            },
          ] as never;
        }
        if (path === "/guilds/guild-1/roles") {
          return [
            { id: "guild-1", permissions: "0" },
            { id: "role-1", permissions: "66560" },
          ] as never;
        }
        if (path === "/guilds/guild-1/channels") {
          return [
            { id: "channel-1", name: "memes", type: 0 },
            {
              id: "hidden-1",
              name: "staff",
              type: 0,
              permission_overwrites: [
                { id: "guild-1", type: 0, allow: "0", deny: "1024" },
              ],
            },
          ] as never;
        }

        return {
          total_results: 1,
          messages: [
            [
              {
                id: "message-1",
                channel_id: "channel-1",
                content: "",
                timestamp: "2026-07-01T12:00:00.000Z",
                author: { id: "user-1", global_name: "Daniel" },
                attachments: [
                  {
                    id: "attachment-1",
                    filename: "meme.png",
                    content_type: "image/png",
                    size: 1234,
                    url: "https://cdn.discordapp.com/meme.png",
                  },
                ],
              },
            ],
          ],
        } as never;
      },
    });

    expect(requestedPaths).toHaveLength(4);
    expect(requestedPaths[3]).toContain("channel_id=channel-1");
    expect(requestedPaths[3]).not.toContain("hidden-1");
    expect(requestedPaths[3]).toContain("author_id=user-1");
    expect(requestedPaths[3]).toContain("has=image");
    expect(results).toHaveLength(1);
    expect(results[0]?.channelName).toBe("memes");
    expect(results[0]?.jumpUrl).toBe(
      "https://discord.com/channels/guild-1/channel-1/message-1",
    );
  });

  test("uses the requester directly for Chinese self-reference", async () => {
    const requestedPaths: string[] = [];
    let searchRequestCount = 0;

    const results = await searchGuildMessages({
      guildId: "guild-1",
      requesterUserId: "owner-1",
      requesterRoleIds: ["role-1"],
      currentChannelId: "channel-2",
      requestMessageId: "request-1",
      queries: [
        { author: "self", content: "新 app" },
        { author: "self", content: "app", has: ["link"] },
      ],
      discordRequest: async (path) => {
        requestedPaths.push(path);
        if (path === "/guilds/guild-1/roles") {
          return [
            { id: "guild-1", permissions: "0" },
            { id: "role-1", permissions: "66560" },
          ] as never;
        }
        if (path === "/guilds/guild-1/channels") {
          return [{ id: "channel-2", name: "projects", type: 0 }] as never;
        }

        searchRequestCount += 1;
        const id = searchRequestCount === 1 ? "request-1" : "target-1";
        return {
          total_results: 1,
          messages: [
            [
              {
                id,
                channel_id: "channel-2",
                content: searchRequestCount === 1 ? "新 app" : "app launch",
                timestamp: "2026-07-01T12:00:00.000Z",
                author: { id: "owner-1", username: "Hsi" },
              },
            ],
          ],
        } as never;
      },
    });

    expect(requestedPaths).toHaveLength(4);
    expect(requestedPaths[2]).not.toContain("/members/search");
    expect(requestedPaths[2]).toContain("author_id=owner-1");
    expect(requestedPaths[2]).toContain("content=%E6%96%B0+app");
    expect(requestedPaths[3]).toContain("content=app");
    expect(requestedPaths[3]).toContain("has=link");
    expect(results.map((result) => result.id)).toEqual(["target-1"]);
    expect(results[0]?.channelName).toBe("projects");
  });

  test("preserves attachments and an older referenced human message", () => {
    expect(
      toChatbotMessage({
        id: "message-2",
        channel_id: "channel-1",
        content: "see this",
        timestamp: "2026-07-20T11:00:00.000Z",
        author: { id: "user-1", global_name: "Hsi" },
        attachments: [
          {
            id: "attachment-1",
            filename: "notes.pdf",
            content_type: "application/pdf",
            size: 1234,
            url: "https://cdn.discordapp.com/notes.pdf",
          },
        ],
        reactions: [
          {
            count: 3,
            emoji: { id: null, name: "😂" },
          },
          {
            count: 2,
            me: true,
            emoji: { id: "emoji-1", name: "sago", animated: true },
          },
        ],
        referenced_message: {
          id: "message-1",
          channel_id: "channel-1",
          content: "older context",
          timestamp: "2026-07-18T11:00:00.000Z",
          author: { id: "user-2", username: "Daniel" },
        },
      }),
    ).toEqual({
      id: "message-2",
      role: "user",
      author: "Hsi",
      timestamp: "2026-07-20T11:00:00.000Z",
      content: "see this",
      attachments: [
        {
          id: "attachment-1",
          filename: "notes.pdf",
          contentType: "application/pdf",
          size: 1234,
          url: "https://cdn.discordapp.com/notes.pdf",
        },
      ],
      reactions: [
        { emoji: "😂", count: 3 },
        { emoji: "<a:sago:emoji-1>", count: 2, me: true },
      ],
      referencedMessage: {
        id: "message-1",
        role: "user",
        author: "Daniel",
        timestamp: "2026-07-18T11:00:00.000Z",
        content: "older context",
        attachments: [],
      },
    });
  });

  test("applies role and member channel overwrites before guild search", () => {
    const roles = [
      { id: "guild-1", permissions: "66560" },
      { id: "role-1", permissions: "0" },
    ];
    const channel = {
      id: "private-1",
      type: 0,
      permission_overwrites: [
        { id: "guild-1", type: 0, allow: "0", deny: "1024" },
        { id: "owner-1", type: 1, allow: "1024", deny: "0" },
      ],
    };

    expect(
      canMemberSearchChannel({
        guildId: "guild-1",
        userId: "owner-1",
        roleIds: ["role-1"],
        roles,
        channel,
      }),
    ).toBe(true);
    expect(
      canMemberSearchChannel({
        guildId: "guild-1",
        userId: "other-1",
        roleIds: ["role-1"],
        roles,
        channel,
      }),
    ).toBe(false);
  });

  test("shortens answers to one Discord message", () => {
    expect(formatDiscordAnswer(" short answer ")).toBe("short answer");
    const longAnswer = "a".repeat(2_100);
    expect(formatDiscordAnswer(longAnswer)).toHaveLength(2_000);
    expect(formatDiscordAnswer(longAnswer).endsWith("…")).toBe(true);
  });
});
