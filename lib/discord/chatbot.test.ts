import { describe, expect, test } from "bun:test";

import {
  extractMentionRequest,
  fallbackGuildSearchQueries,
  formatDiscordAnswer,
  getRecentHumanMessages,
  isChatbotAuthorized,
  isHumanContextMessage,
  parseDiscordSearchPlan,
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

  test("validates and limits Codex Discord search plans", () => {
    expect(
      parseDiscordSearchPlan(`\`\`\`json
{"queries":[{"author":"self","content":"new app"},{"has":["link","file","invalid"]},{"embedType":"gif"},{"attachmentExtension":".pdf"},{"content":"ignored"}]}
\`\`\``),
    ).toEqual([
      { author: "self", content: "new app" },
      { has: ["link", "file"] },
      { embedType: "gif" },
      { attachmentExtension: "pdf" },
    ]);
    expect(parseDiscordSearchPlan("not json")).toEqual([]);
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
        if (path === "/guilds/guild-1/channels") {
          return [{ id: "channel-1", name: "memes" }] as never;
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

    expect(requestedPaths).toHaveLength(3);
    expect(requestedPaths[1]).not.toContain("channel_id=");
    expect(requestedPaths[1]).toContain("author_id=user-1");
    expect(requestedPaths[1]).toContain("has=image");
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
      requestMessageId: "request-1",
      queries: [
        { author: "self", content: "新 app" },
        { author: "self", content: "app", has: ["link"] },
      ],
      discordRequest: async (path) => {
        requestedPaths.push(path);
        if (path === "/guilds/guild-1/channels") {
          return [{ id: "channel-2", name: "projects" }] as never;
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

    expect(requestedPaths).toHaveLength(3);
    expect(requestedPaths[0]).not.toContain("/members/search");
    expect(requestedPaths[0]).toContain("author_id=owner-1");
    expect(requestedPaths[0]).toContain("content=%E6%96%B0+app");
    expect(requestedPaths[1]).toContain("content=app");
    expect(requestedPaths[1]).toContain("has=link");
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
      referencedMessage: {
        id: "message-1",
        author: "Daniel",
        timestamp: "2026-07-18T11:00:00.000Z",
        content: "older context",
        attachments: [],
      },
    });
  });

  test("shortens answers to one Discord message", () => {
    expect(formatDiscordAnswer(" short answer ")).toBe("short answer");
    const longAnswer = "a".repeat(2_100);
    expect(formatDiscordAnswer(longAnswer)).toHaveLength(2_000);
    expect(formatDiscordAnswer(longAnswer).endsWith("…")).toBe(true);
  });
});
