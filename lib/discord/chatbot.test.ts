import { describe, expect, test } from "bun:test";

import {
  extractMentionRequest,
  formatDiscordAnswer,
  isHumanContextMessage,
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

  test("accepts only recent human context messages other than the request", () => {
    const cutoff = new Date("2026-07-19T12:00:00.000Z");
    const base = {
      id: "message-1",
      channel_id: "channel-1",
      content: "hello",
      timestamp: "2026-07-20T11:00:00.000Z",
      author: { id: "user-1", username: "Hsi" },
    };

    expect(isHumanContextMessage(base, "request", cutoff)).toBe(true);
    expect(isHumanContextMessage(base, "message-1", cutoff)).toBe(false);
    expect(
      isHumanContextMessage(
        { ...base, author: { ...base.author, bot: true } },
        "request",
        cutoff,
      ),
    ).toBe(false);
    expect(
      isHumanContextMessage(
        { ...base, timestamp: "2026-07-19T11:59:59.000Z" },
        "request",
        cutoff,
      ),
    ).toBe(false);
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
