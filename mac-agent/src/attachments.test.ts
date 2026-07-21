import { access } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import type { ChatbotJob } from "../../lib/chatbot/protocol";
import { attachmentLimits, prepareAttachments } from "./attachments";

describe("chatbot attachment limits", () => {
  test("caps downloads at ten files and twenty megabytes each", () => {
    expect(attachmentLimits).toEqual({
      count: 10,
      bytes: 20 * 1024 * 1024,
      totalBytes: 40 * 1024 * 1024,
      extractedCharacters: 100_000,
      totalExtractedCharacters: 200_000,
    });
  });

  test("explains oversized attachments with the selected Chinese copy", async () => {
    const prepared = await prepareAttachments({
      id: "job-large-file",
      requesterUserId: "test-user",
      channelId: "channel-1",
      requestMessageId: "message-1",
      request: "read this",
      messages: [
        {
          id: "message-1",
          author: "Hsi",
          timestamp: "2026-07-20T10:00:00.000Z",
          content: "notes",
          attachments: [
            {
              id: "attachment-large",
              filename: "huge.pdf",
              contentType: "application/pdf",
              size: 20 * 1024 * 1024 + 1,
              url: "https://cdn.discordapp.com/huge.pdf",
            },
          ],
        },
      ],
    });

    expect(prepared.ignored).toEqual([
      "附件 huge.pdf 超過 20 MB 我吃不下 換小一點的檔案吧",
    ]);
    await prepared.cleanup();
  });

  test.serial(
    "extracts text attachments and removes temporary files",
    async () => {
      const originalFetch = globalThis.fetch;
      const job: ChatbotJob = {
        id: "job-1",
        requesterUserId: "test-user",
        channelId: "channel-1",
        requestMessageId: "message-2",
        request: "What is in the notes?",
        messages: [
          {
            id: "message-1",
            author: "Hsi",
            timestamp: "2026-07-20T10:00:00.000Z",
            content: "Here are the notes",
            attachments: [
              {
                id: "attachment-1",
                filename: "notes.txt",
                contentType: "text/plain",
                size: 19,
                url: "https://cdn.discordapp.com/notes.txt",
              },
            ],
          },
        ],
        searchResults: [
          {
            id: "message-search-1",
            author: "Daniel",
            timestamp: "2026-06-01T10:00:00.000Z",
            content: "Earlier search match",
            attachments: [
              {
                id: "attachment-search-1",
                filename: "meme.png",
                contentType: "image/png",
                size: 17,
                url: "https://cdn.discordapp.com/meme.png",
              },
            ],
            jumpUrl:
              "https://discord.com/channels/guild-1/channel-1/message-search-1",
          },
        ],
      };

      globalThis.fetch = (async () =>
        new Response("Ship next Friday.", {
          headers: { "Content-Length": "17" },
        })) as unknown as typeof fetch;

      try {
        const prepared = await prepareAttachments(job);
        expect(prepared.textBlocks).toEqual([
          "Attachment: notes.txt\nShip next Friday.",
        ]);
        expect(prepared.imagePaths).toHaveLength(1);
        expect(prepared.ignored).toEqual([]);
        await prepared.cleanup();
        expect(access(prepared.directory)).rejects.toThrow();
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  test.serial("includes attachments on the triggering mention", async () => {
    const originalFetch = globalThis.fetch;
    const job: ChatbotJob = {
      id: "job-2",
      requesterUserId: "test-user",
      channelId: "channel-1",
      requestMessageId: "message-2",
      request: "read this",
      requestMessage: {
        id: "message-2",
        author: "Hsi",
        timestamp: "2026-07-20T10:00:00.000Z",
        content: "@MiniSago read this",
        attachments: [
          {
            id: "attachment-2",
            filename: "request.txt",
            contentType: "text/plain",
            size: 15,
            url: "https://cdn.discordapp.com/request.txt",
          },
        ],
      },
      messages: [],
    };

    globalThis.fetch = (async () =>
      new Response("Mention context", {
        headers: { "Content-Length": "15" },
      })) as unknown as typeof fetch;

    try {
      const prepared = await prepareAttachments(job);
      expect(prepared.textBlocks).toEqual([
        "Attachment: request.txt\nMention context",
      ]);
      await prepared.cleanup();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.serial(
    "stops before downloading when the request is cancelled",
    async () => {
      const originalFetch = globalThis.fetch;
      let fetched = false;
      globalThis.fetch = (async () => {
        fetched = true;
        return new Response("unused");
      }) as unknown as typeof fetch;
      const controller = new AbortController();
      controller.abort();

      try {
        await expect(
          prepareAttachments(
            {
              id: "job-cancelled",
              requesterUserId: "test-user",
              channelId: "channel-1",
              requestMessageId: "message-1",
              request: "read this",
              messages: [
                {
                  id: "message-1",
                  author: "Hsi",
                  timestamp: "2026-07-20T10:00:00.000Z",
                  content: "notes",
                  attachments: [
                    {
                      id: "attachment-1",
                      filename: "notes.txt",
                      contentType: "text/plain",
                      size: 5,
                      url: "https://cdn.discordapp.com/notes.txt",
                    },
                  ],
                },
              ],
            },
            controller.signal,
          ),
        ).rejects.toThrow();
        expect(fetched).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});
